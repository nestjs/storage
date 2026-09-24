/**
 * Just enough XML for S3's responses: flat elements, found by name. S3 never nests an element
 * inside one with the same name, and its documents have no CDATA or comments.
 */

const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(ENTITY, (_, hex: string, dec: string, named: string) => {
    if (named) {
      return NAMED[named.toLowerCase()];
    }
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

export function encodeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);
}

/** The inner XML of every `<tag>` element (and `''` for `<tag/>`). */
export function xmlElements(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? '');
}

/** The decoded text of the first `<tag>` element. */
export function xmlText(xml: string, tag: string): string | undefined {
  const [first] = xmlElements(xml, tag);
  return first === undefined ? undefined : decodeXml(first);
}
