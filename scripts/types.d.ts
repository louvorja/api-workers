declare module 'bmp-js' {
  export function decode(buffer: Buffer): { data: Buffer; width: number; height: number }
  const _default: { decode: typeof decode }
  export default _default
}
