// The playground build imports example programs as plain text (esbuild 'text' loader).
declare module '*.gly' {
  const source: string;
  export default source;
}
