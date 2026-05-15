/**
 * Storage provider factory.
 *
 * STORAGE_DRIVER selects "local" (default) or "s3" (stub today).
 * The returned provider is cached for the lifetime of the process.
 */
import type { StorageProvider } from "../contracts";
import { LocalFsStorage } from "./local-fs";
import { S3Storage } from "./s3";

let cached: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (cached) return cached;
  const driver = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();
  switch (driver) {
    case "s3":
      cached = new S3Storage();
      break;
    case "local":
    case "":
    case undefined:
      cached = new LocalFsStorage();
      break;
    default:
      throw new Error(
        `Unknown STORAGE_DRIVER=${process.env.STORAGE_DRIVER}; expected "local" or "s3"`
      );
  }
  return cached;
}
