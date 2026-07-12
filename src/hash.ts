import crypto from 'node:crypto';

export function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}
