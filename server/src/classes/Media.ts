/**
 * An uploaded file: an object in the assets bucket (the ObjectStore, utils/s3Util.ts) and its
 * Media row, kept together by this class, the only code that touches the Media collection.
 *
 * - `upload` strips the image metadata, stores the object under `media/<folder>/` and creates the
 *   row (recording the stripped size); a row that can't be created takes its object back with it.
 * - `remove` (one, by id) and `removeAllOf` (an uploader's) delete the objects, then the rows. The
 *   row writes are private, so no row is made or deleted apart from its object. Both are account
 *   operations of the signed-in user (controllers/account.ts), pinned there by
 *   mediaDoors.test.ts: a file belongs to its uploader, not to a workspace (an Entity, not a
 *   WorkspaceEntity), so there is no workspace Caller to take.
 */
import { getMediaRepository, type MediaData } from '../models/index.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { deleteFile, uploadFile } from '../utils/s3Util.js';
import { stripImageMetadata } from '../utils/stripMetadata/index.js';
import { Entity } from './base/Entity.js';

const S3_DELETE_CONCURRENCY = 20;

/** What an upload takes: the file, where it goes and who uploads it. */
export interface MediaUpload {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  /** Sub-folder under `media/` (e.g. accountImageFolder(userId)). */
  folder: string;
  uploadedBy: string;
}

/** A Media row as it is created (the store fills id and the timestamps). */
type NewMediaRow = Omit<MediaData, 'id' | 'createdAt' | 'updatedAt'>;

export class Media extends Entity<MediaData> {
  private constructor(data: MediaData) {
    super(data);
  }

  get s3Key(): string {
    return this.data.s3Key;
  }

  get s3Url(): string {
    return this.data.s3Url;
  }

  get cloudfrontUrl(): string {
    return this.data.cloudfrontUrl;
  }

  get fileName(): string {
    return this.data.fileName;
  }

  get mimeType(): string {
    return this.data.mimeType;
  }

  get size(): number {
    return this.data.size;
  }

  get uploadedBy(): string {
    return this.data.uploadedBy;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  get updatedAt(): Date {
    return this.data.updatedAt;
  }

  /** The row's fields, exactly these. */
  override toJSON(): MediaData {
    return {
      id: this.id,
      s3Key: this.s3Key,
      s3Url: this.s3Url,
      cloudfrontUrl: this.cloudfrontUrl,
      fileName: this.fileName,
      mimeType: this.mimeType,
      size: this.size,
      uploadedBy: this.uploadedBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static async findById(id: string): Promise<Media | null> {
    const repo = await getMediaRepository();
    const data = await repo.findById(id);
    return data ? new Media(data) : null;
  }

  static async findByUploadedBy(userId: string): Promise<Media[]> {
    const repo = await getMediaRepository();
    const records = await repo.findByUploadedBy(userId);
    return records.map((data) => new Media(data));
  }

  /**
   * Strips metadata, uploads, and creates the Media row (recording the stripped size). If the row
   * can't be created the uploaded object is removed again.
   */
  static async upload(params: MediaUpload): Promise<Media> {
    const clean = stripImageMetadata(params.buffer, params.mimeType);
    const uploaded = await uploadFile({
      buffer: clean,
      fileName: params.fileName,
      mimeType: params.mimeType,
      folder: params.folder,
    });
    try {
      return await Media.#create({
        s3Key: uploaded.s3Key,
        s3Url: uploaded.s3Url,
        cloudfrontUrl: uploaded.cloudfrontUrl,
        fileName: params.fileName,
        mimeType: params.mimeType,
        size: clean.length,
        uploadedBy: params.uploadedBy,
      });
    } catch (error) {
      await deleteFile(uploaded.s3Key).catch((cleanupError: unknown) => {
        console.warn('Failed to remove orphaned upload %s:', uploaded.s3Key, cleanupError);
      });
      throw error;
    }
  }

  /** Deletes a Media row and its S3 object. A missing row is a no-op. */
  static async remove(mediaId: string): Promise<void> {
    const media = await Media.findById(mediaId);
    if (media === null) return;
    await deleteFile(media.s3Key);
    await Media.#deleteById(media.id);
  }

  /** Deletes every Media row uploaded by `userId`, and their S3 objects. */
  static async removeAllOf(userId: string): Promise<void> {
    const media = await Media.findByUploadedBy(userId);
    await runWithConcurrency(media, S3_DELETE_CONCURRENCY, (m) => deleteFile(m.s3Key));
    await Media.#deleteByUploadedBy(userId);
  }

  static async #create(data: NewMediaRow): Promise<Media> {
    const repo = await getMediaRepository();
    const mediaData = await repo.create(data);
    return new Media(mediaData);
  }

  static async #deleteById(id: string): Promise<void> {
    const repo = await getMediaRepository();
    await repo.deleteById(id);
  }

  static async #deleteByUploadedBy(userId: string): Promise<void> {
    const repo = await getMediaRepository();
    await repo.deleteByUploadedBy(userId);
  }
}
