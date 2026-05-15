/**
 * S3-compatible storage stub.
 *
 * Phase 1 doesn't ship an S3 driver — but the class shape must exist so the
 * factory can import it without a guard. Every method throws on call.
 */
import type {
  StorageGetRange,
  StorageGetResponse,
  StoragePresignRequest,
  StoragePresignResponse,
  StorageProvider,
} from "../contracts";

const NOT_IMPLEMENTED = "S3 storage not implemented yet";

export class S3Storage implements StorageProvider {
  async presignPut(_req: StoragePresignRequest): Promise<StoragePresignResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async putStream(
    _key: string,
    _body: ReadableStream<Uint8Array> | Buffer | Uint8Array,
    _contentType: string
  ): Promise<{ publicUrl: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getStream(
    _key: string,
    _range?: StorageGetRange
  ): Promise<StorageGetResponse> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async exists(_key: string): Promise<boolean> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async delete(_key: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  keyForChunk(_sessionId: string, _chunkIndex: number, _ext: string): string {
    throw new Error(NOT_IMPLEMENTED);
  }

  keyForFinalAudio(_sessionId: string, _ext: string): string {
    throw new Error(NOT_IMPLEMENTED);
  }

  keyForFolderDocument(_folderId: string, _docId: string, _ext: string): string {
    throw new Error(NOT_IMPLEMENTED);
  }

  publicUrlFor(_key: string): string {
    throw new Error(NOT_IMPLEMENTED);
  }
}
