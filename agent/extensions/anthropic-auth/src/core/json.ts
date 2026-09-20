export function parseJsonRedacted(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new SyntaxError('invalid JSON')
    throw error
  }
}
