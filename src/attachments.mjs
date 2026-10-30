import { join } from 'node:path';
import { check } from './errors.mjs';
import { sha256 } from './claude.mjs';

// Native preparation decodes and normalizes in memory. Preview never publishes.
export async function prepareAttachments(input, runtime) {
  const api = runtime.attachment;
  const ctx = new runtime.Context();
  const service = new api.LocalAttachmentStore(ctx, { dshHome: '/' });
  const images = new Map();
  async function walk(blocks) {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block.type === 'image') {
        const key = sha256(JSON.stringify(block));
        if (images.has(key)) continue;
        const source = block.source;
        check(source?.type === 'base64' && typeof source.data === 'string' && source.data.length > 0,
          'ATTACHMENT_UNSUPPORTED', '仅支持来源内嵌的 base64 图片，不自动访问外部 URL。');
        const data = Buffer.from(source.data, 'base64');
        check(data.toString('base64') === source.data, 'ATTACHMENT_ENCODING', '图片不是规范 base64。');
        const prepared = await api.prepareImageFile({ data, mediaType: source.media_type }, service.imageLimits, service.normalizationPolicy);
        images.set(key, prepared);
      }
      if (block.type === 'tool_result') await walk(block.content);
    }
  }
  for (const row of input.records) await walk(row.message?.content);
  return images;
}
export async function publishAttachments(images, runtime, dshHome) {
  const root = join(dshHome, 'attachments', 'v1');
  for (const image of images.values()) {
    await runtime.attachment.commitPreparedImageFile(root, image);
    await runtime.attachment.readImageFile(root, image.ref);
  }
}
export async function verifyAttachments(events, runtime, dshHome) {
  const refs = new Map();
  for (const event of events) for (const block of (event.data?.message || event.data)?.content || []) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment);
  }
  for (const ref of refs.values()) await runtime.attachment.readImageFile(join(dshHome, 'attachments', 'v1'), ref);
  return refs.size;
}
