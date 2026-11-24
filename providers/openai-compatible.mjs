// Optional semantic layer. Works with any OpenAI-compatible /v1/embeddings endpoint, including Ollama.
//
//   .codeceo/config.json:  { "retrieval": { "embeddings": { "module": "<path to this file>" } } }
//   then:                  codeceo sync --embed
//
// Env: CODECEO_EMBED_URL   (default http://localhost:11434/v1/embeddings)
//      CODECEO_EMBED_MODEL (default nomic-embed-text)
//      CODECEO_EMBED_KEY   (optional bearer token)
export async function embed(texts) {
  const url = process.env.CODECEO_EMBED_URL ?? 'http://localhost:11434/v1/embeddings';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.CODECEO_EMBED_KEY ? { authorization: `Bearer ${process.env.CODECEO_EMBED_KEY}` } : {}),
    },
    body: JSON.stringify({ model: process.env.CODECEO_EMBED_MODEL ?? 'nomic-embed-text', input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings endpoint answered ${res.status}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
