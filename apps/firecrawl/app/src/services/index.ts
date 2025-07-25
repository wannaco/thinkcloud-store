import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger as _logger } from "../lib/logger";
import { configDotenv } from "dotenv";
import { ApiError, Storage } from "@google-cloud/storage";
import crypto from "crypto";
import { redisEvictConnection } from "./redis";
import type { Logger } from "winston";
import psl from "psl";
configDotenv();

// SupabaseService class initializes the Supabase client conditionally based on environment variables.
class IndexSupabaseService {
  private client: SupabaseClient | null = null;

  constructor() {
    const supabaseUrl = process.env.INDEX_SUPABASE_URL;
    const supabaseServiceToken = process.env.INDEX_SUPABASE_SERVICE_TOKEN;
    // Only initialize the Supabase client if both URL and Service Token are provided.
    if (!supabaseUrl || !supabaseServiceToken) {
      // Warn the user that Authentication is disabled by setting the client to null
      _logger.warn(
        "Index supabase client will not be initialized.",
      );
      this.client = null;
    } else {
      this.client = createClient(supabaseUrl, supabaseServiceToken);
    }
  }

  // Provides access to the initialized Supabase client, if available.
  getClient(): SupabaseClient | null {
    return this.client;
  }
}

const serv = new IndexSupabaseService();

// Using a Proxy to handle dynamic access to the Supabase client or service methods.
// This approach ensures that if Supabase is not configured, any attempt to use it will result in a clear error.
export const index_supabase_service: SupabaseClient = new Proxy(
  serv,
  {
    get: function (target, prop, receiver) {
      const client = target.getClient();
      // If the Supabase client is not initialized, intercept property access to provide meaningful error feedback.
      if (client === null) {
        return () => {
          throw new Error("Index supabase client is not configured.");
        };
      }
      // Direct access to SupabaseService properties takes precedence.
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // Otherwise, delegate access to the Supabase client.
      return Reflect.get(client, prop, receiver);
    },
  },
) as unknown as SupabaseClient;

const credentials = process.env.GCS_CREDENTIALS ? JSON.parse(atob(process.env.GCS_CREDENTIALS)) : undefined;

export async function getIndexFromGCS(url: string, logger?: Logger): Promise<any | null> {
    //   logger.info(`Getting f-engine document from GCS`, {
    //     url,
    //   });
    try {
        if (!process.env.GCS_INDEX_BUCKET_NAME) {
            return null;
        }

        const storage = new Storage({ credentials });
        const bucket = storage.bucket(process.env.GCS_INDEX_BUCKET_NAME);
        const blob = bucket.file(`${url}`);
        const [blobContent] = await blob.download();
        const parsed = JSON.parse(blobContent.toString());
        return parsed;
    } catch (error) {
        if (error instanceof ApiError && error.code === 404 && error.message.includes("No such object:")) {
          // Object does not exist
          return null;
        }

        (logger ?? _logger).error(`Error getting Index document from GCS`, {
            error,
            url,
        });
        return null;
    }
}


export async function saveIndexToGCS(id: string, doc: {
  url: string;
  html: string;
  statusCode: number;
  error?: string;
  screenshot?: string;
  numPages?: number;
}): Promise<void> {
  try {
      if (!process.env.GCS_INDEX_BUCKET_NAME) {
          return;
      }

      const storage = new Storage({ credentials });
      const bucket = storage.bucket(process.env.GCS_INDEX_BUCKET_NAME);
      const blob = bucket.file(`${id}.json`);
      for (let i = 0; i < 3; i++) {
          try {
              await blob.save(JSON.stringify(doc), { 
                  contentType: "application/json",
              });
              break;
          } catch (error) {
              if (i === 2) {
                  throw error;
              } else {
                  _logger.error(`Error saving index document to GCS, retrying`, {
                      error,
                      indexId: id,
                      i,
                  });
              }
          }
      }
  } catch (error) {
    throw new Error("Error saving index document to GCS", {
      cause: error,
    });
  }
}

export const useIndex =
    process.env.INDEX_SUPABASE_URL !== "" &&
    process.env.INDEX_SUPABASE_URL !== undefined;

export function normalizeURLForIndex(url: string): string {
    const urlObj = new URL(url);
    urlObj.hash = "";
    urlObj.protocol = "https";

    if (urlObj.port === "80" || urlObj.port === "443") {
        urlObj.port = "";
    }

    if (urlObj.hostname.startsWith("www.")) {
        urlObj.hostname = urlObj.hostname.slice(4);
    }

    if (urlObj.pathname.endsWith("/index.html")) {
        urlObj.pathname = urlObj.pathname.slice(0, -10);
    } else if (urlObj.pathname.endsWith("/index.php")) {
        urlObj.pathname = urlObj.pathname.slice(0, -9);
    } else if (urlObj.pathname.endsWith("/index.htm")) {
        urlObj.pathname = urlObj.pathname.slice(0, -9);
    } else if (urlObj.pathname.endsWith("/index.shtml")) {
        urlObj.pathname = urlObj.pathname.slice(0, -11);
    } else if (urlObj.pathname.endsWith("/index.xml")) {
        urlObj.pathname = urlObj.pathname.slice(0, -9);
    }

    if (urlObj.pathname.endsWith("/")) {
        urlObj.pathname = urlObj.pathname.slice(0, -1);
    }

    return urlObj.toString();
}

export function hashURL(url: string): string {
    return "\\x" + crypto.createHash("sha256").update(url).digest("hex");
}

export function generateURLSplits(url: string): string[] {
  const urls: string[] = [];
  const urlObj = new URL(url);
  urlObj.hash = "";
  urlObj.search = "";
  const pathnameParts = urlObj.pathname.split("/");

  for (let i = 0; i <= pathnameParts.length; i++) {
      urlObj.pathname = pathnameParts.slice(0, i).join("/");
      urls.push(urlObj.href);
  }

  urls.push(url);

  return [...new Set(urls.map(x => normalizeURLForIndex(x)))];
}

export function generateDomainSplits(hostname: string): string[] {
  const parsed = psl.parse(hostname);
  if (parsed === null) {
    return [];
  }

  const subdomains: string[] = (parsed.subdomain ?? "").split(".").filter(x => x !== "");
  if (subdomains.length === 1 && subdomains[0] === "www") {
    return [parsed.domain];
  }

  const domains: string[] = [];
  for (let i = subdomains.length; i >= 0; i--) {
    domains.push(subdomains.slice(i).concat([parsed.domain]).join("."));
  }

  return domains;
}

const INDEX_INSERT_QUEUE_KEY = "index-insert-queue";
const INDEX_INSERT_BATCH_SIZE = 100;

export async function addIndexInsertJob(data: any) {
  await redisEvictConnection.rpush(INDEX_INSERT_QUEUE_KEY, JSON.stringify(data));
}

export async function getIndexInsertJobs(): Promise<any[]> {
  const jobs = (await redisEvictConnection.lpop(INDEX_INSERT_QUEUE_KEY, INDEX_INSERT_BATCH_SIZE)) ?? [];
  return jobs.map(x => JSON.parse(x));
}

export async function processIndexInsertJobs() {
  const jobs = await getIndexInsertJobs();
  if (jobs.length === 0) {
    return;
  }
  _logger.info(`Index inserter found jobs to insert`, { jobCount: jobs.length });
  try {
    const { error } = await index_supabase_service.from("index").insert(jobs);
    if (error) {
      _logger.error(`Index inserter failed to insert jobs`, { error, jobCount: jobs.length });
    }
    _logger.info(`Index inserter inserted jobs`, { jobCount: jobs.length });
  } catch (error) {
    _logger.error(`Index inserter failed to insert jobs`, { error, jobCount: jobs.length });
  }
}

export async function getIndexInsertQueueLength(): Promise<number> {
  return await redisEvictConnection.llen(INDEX_INSERT_QUEUE_KEY) ?? 0;
}

const INDEX_RF_INSERT_QUEUE_KEY = "index-rf-insert-queue";
const INDEX_RF_INSERT_BATCH_SIZE = 100;

export async function addIndexRFInsertJob(data: any) {
  await redisEvictConnection.rpush(INDEX_RF_INSERT_QUEUE_KEY, JSON.stringify(data));
}

export async function getIndexRFInsertJobs(): Promise<any[]> {
  const jobs = (await redisEvictConnection.lpop(INDEX_RF_INSERT_QUEUE_KEY, INDEX_RF_INSERT_BATCH_SIZE)) ?? [];
  return jobs.map(x => JSON.parse(x));
}

export async function processIndexRFInsertJobs() {
  const jobs = await getIndexRFInsertJobs();
  if (jobs.length === 0) {
    return;
  }
  _logger.info(`Index RF inserter found jobs to insert`, { jobCount: jobs.length });
  try {
    const { error } = await index_supabase_service.from("request_frequency").insert(jobs);
    if (error) {
      _logger.error(`Index RF inserter failed to insert jobs`, { error, jobCount: jobs.length });
    }
    _logger.info(`Index RF inserter inserted jobs`, { jobCount: jobs.length });
  } catch (error) {
    _logger.error(`Index RF inserter failed to insert jobs`, { error, jobCount: jobs.length });
  }
}

export async function getIndexRFInsertQueueLength(): Promise<number> {
  return await redisEvictConnection.llen(INDEX_RF_INSERT_QUEUE_KEY) ?? 0;
}

const OMCE_JOB_QUEUE_KEY = "omce-job-queue";
const OMCE_JOB_QUEUE_BATCH_SIZE = 100;

export async function addOMCEJob(data: [number, string]) {
  await redisEvictConnection.sadd(OMCE_JOB_QUEUE_KEY, JSON.stringify(data));
}

export async function getOMCEJobs(): Promise<[number, string][]> {
  const jobs = (await redisEvictConnection.spop(OMCE_JOB_QUEUE_KEY, OMCE_JOB_QUEUE_BATCH_SIZE)) ?? [];
  return jobs.map(x => JSON.parse(x) as [number, string]);
}

export async function processOMCEJobs() {
  const jobs = await getOMCEJobs();
  if (jobs.length === 0) {
    return;
  }
  _logger.info(`OMCE job inserter found jobs to insert`, { jobCount: jobs.length });
  try {
    for (const job of jobs) {
      const [level, hash] = job;
      const { error } = await index_supabase_service.rpc("insert_omce_job_if_needed", {
        i_domain_level: level,
        i_domain_hash: hash,
      });

      if (error) {
        _logger.error(`OMCE job inserter failed to insert job`, { error, job, jobCount: jobs.length });
      }
    }
    _logger.info(`OMCE job inserter inserted jobs`, { jobCount: jobs.length });
  } catch (error) {
    _logger.error(`OMCE job inserter failed to insert jobs`, { error, jobCount: jobs.length });
  }
}

export async function getOMCEQueueLength(): Promise<number> {
  return await redisEvictConnection.scard(OMCE_JOB_QUEUE_KEY) ?? 0;
}

export async function queryIndexAtSplitLevel(url: string, limit: number, maxAge = 2 * 24 * 60 * 60 * 1000): Promise<string[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const urlObj = new URL(url);
  urlObj.search = "";

  const urlSplitsHash = generateURLSplits(urlObj.href).map(x => hashURL(x));

  const level = urlSplitsHash.length - 1;

  let links: Set<string> = new Set();
  let iteration = 0;

  while (true) {
    // Query the index for the next set of links
    const { data: _data, error } = await index_supabase_service
      .rpc("query_index_at_split_level", {
        i_level: level,
        i_url_hash: urlSplitsHash[level],
        i_newer_than: new Date(Date.now() - maxAge).toISOString(),
      })
      .range(iteration * 1000, (iteration + 1) * 1000)

    // If there's an error, return the links we have
    if (error) {
      _logger.warn("Error querying index", { error, url, limit });
      return [...links].slice(0, limit);
    }

    // Add the links to the set
    const data = _data ?? [];
    data.forEach((x) => links.add(x.resolved_url));

    // If we have enough links, return them
    if (links.size >= limit) {
      return [...links].slice(0, limit);
    }

    // If we get less than 1000 links from the query, we're done
    if (data.length < 1000) {
      return [...links].slice(0, limit);
    }

    iteration++;
  }
}

export async function queryIndexAtDomainSplitLevel(hostname: string, limit: number, maxAge = 2 * 24 * 60 * 60 * 1000): Promise<string[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const domainSplitsHash = generateDomainSplits(hostname).map(x => hashURL(x));

  const level = domainSplitsHash.length - 1;
  if (domainSplitsHash.length === 0) {
    return [];
  }

  let links: Set<string> = new Set();
  let iteration = 0;

  while (true) {
    // Query the index for the next set of links
    const { data: _data, error } = await index_supabase_service
      .rpc("query_index_at_domain_split_level", {
        i_level: level,
        i_domain_hash: domainSplitsHash[level],
        i_newer_than: new Date(Date.now() - maxAge).toISOString(),
      })
      .range(iteration * 1000, (iteration + 1) * 1000)

    // If there's an error, return the links we have
    if (error) {
      _logger.warn("Error querying index", { error, hostname, limit });
      return [...links].slice(0, limit);
    }

    // Add the links to the set
    const data = _data ?? [];
    data.forEach((x) => links.add(x.resolved_url));

    // If we have enough links, return them
    if (links.size >= limit) {
      return [...links].slice(0, limit);
    }

    // If we get less than 1000 links from the query, we're done
    if (data.length < 1000) {
      return [...links].slice(0, limit);
    }

    iteration++;
  }
}

export async function queryOMCESignatures(hostname: string, maxAge = 2 * 24 * 60 * 60 * 1000): Promise<string[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const domainSplitsHash = generateDomainSplits(hostname).map(x => hashURL(x));

  const level = domainSplitsHash.length - 1;
  if (domainSplitsHash.length === 0) {
    return [];
  }

  const { data, error } = await index_supabase_service
    .rpc("query_omce_signatures", {
      i_domain_hash: domainSplitsHash[level],
      i_newer_than: new Date(Date.now() - maxAge).toISOString(),
    });

  if (error) {
    _logger.warn("Error querying index (omce)", { error, hostname });
    return [];
  }

  return data?.[0]?.signatures ?? [];
}
