/**
 * Storage abstraction for document files.
 *
 * All consumer code imports from this module — the concrete backend
 * (Supabase Storage, S3, R2, local FS) is selected here and can be
 * swapped without touching callers.
 */

export interface StorageProvider {
  upload(path: string, buffer: Buffer, contentType?: string): Promise<void>
  download(path: string): Promise<Buffer>
  delete(path: string): Promise<void>
  deletePrefix(prefix: string): Promise<void>
  signedUrl(path: string, expiresIn: number): Promise<string>
}

// ── Supabase Storage backend ────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from 'astro:env/server'

const BUCKET = 'documents'

class SupabaseStorage implements StorageProvider {
  private get client() {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for document storage')
    }
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  }

  async upload(path: string, buffer: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(path, buffer, {
        contentType,
        upsert: false,
      })
    if (error) throw new Error(`Storage upload failed: ${error.message}`)
  }

  async download(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .download(path)
    if (error) throw new Error(`Storage download failed: ${error.message ?? JSON.stringify(error)}`)
    return Buffer.from(await data.arrayBuffer())
  }

  async delete(path: string): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .remove([path])
    if (error) {
      console.warn(`[storage] delete failed for ${path}: ${error.message}`)
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .list(prefix)
    if (error || !data || data.length === 0) return

    const paths = data.map((f) => `${prefix}/${f.name}`)
    const { error: removeError } = await this.client.storage
      .from(BUCKET)
      .remove(paths)
    if (removeError) {
      console.warn(`[storage] deletePrefix failed for ${prefix}: ${removeError.message}`)
    }
  }

  async signedUrl(path: string, expiresIn: number): Promise<string> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(path, expiresIn)
    if (error) throw new Error(`Storage signedUrl failed: ${error.message}`)
    return data.signedUrl
  }
}

// ── Singleton + public API ──────────────────────────────────

const storage: StorageProvider = new SupabaseStorage()

/**
 * Build the storage path for a document's original file.
 * Format: {userId}/{documentId}/original{ext}
 */
export function storagePath(userId: string, documentId: string, ext: string): string {
  return `${userId}/${documentId}/original${ext}`
}

export async function uploadDocument(
  userId: string,
  documentId: string,
  ext: string,
  buffer: Buffer,
): Promise<string> {
  const path = storagePath(userId, documentId, ext)
  await storage.upload(path, buffer)
  return path
}

export async function downloadDocument(path: string): Promise<Buffer> {
  return storage.download(path)
}

export async function deleteDocument(path: string): Promise<void> {
  return storage.delete(path)
}

// ── Image storage ───────────────────────────────────────────

/**
 * Upload an extracted image to Supabase Storage.
 * Path: {userId}/{documentId}/images/{filename}
 * The filename comes from the extractor (content-hash based).
 */
export async function uploadImage(
  userId: string,
  documentId: string,
  filename: string,
  buffer: Buffer,
  mime: string,
): Promise<string> {
  const path = `${userId}/${documentId}/images/${filename}`
  await storage.upload(path, buffer, mime)
  return path
}

/**
 * Generate a signed URL for an image (1-hour expiry).
 */
export async function getImageSignedUrl(storagePath: string): Promise<string> {
  return storage.signedUrl(storagePath, 3600)
}

/**
 * Delete all images for a document from storage.
 */
export async function deleteDocumentImages(userId: string, documentId: string): Promise<void> {
  return storage.deletePrefix(`${userId}/${documentId}/images`)
}
