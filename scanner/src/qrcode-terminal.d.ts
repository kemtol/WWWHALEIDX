declare module 'qrcode-terminal' {
  interface Options { small?: boolean }
  const qrcode: {
    generate(text: string, opts?: Options, cb?: (ascii: string) => void): void;
    setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;
  };
  export default qrcode;
}
