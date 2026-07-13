/** Node ESM loader used only by schemaRoundTrip.test.ts. */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (new URL(resolved.url).pathname.endsWith('.css')) {
    return {
      url: 'data:text/javascript,export default {}',
      shortCircuit: true,
    };
  }
  return resolved;
}
