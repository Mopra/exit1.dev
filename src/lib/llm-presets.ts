// One-click presets for the LLM check type. Selecting a provider prefills the
// CheckForm fields with a working canary request: a tiny "Reply with PONG"
// prompt plus a default assertion that catches silent model fallback
// (e.g. you ask for Opus, the provider quietly serves a cheaper model).
//
// Field shapes match how CheckForm stores them: `requestHeaders` is a
// newline-joined "Key: Value" string, `expectedStatusCodes`/`containsText` are
// comma strings, and `url` is the host+path WITHOUT the protocol (the form keeps
// the `https://` prefix separately).

export type LlmProviderId = 'anthropic' | 'openai' | 'gemini' | 'custom';

export interface LlmPreset {
  id: LlmProviderId;
  label: string;
  /** Host + path, no protocol (the form stores the protocol separately). */
  url: string;
  httpMethod: 'POST';
  /** Newline-joined "Key: Value" header lines. */
  requestHeaders: string;
  /** JSON request body. */
  requestBody: string;
  /** Comma-joined acceptable status codes. */
  expectedStatusCodes: string;
  /** Comma-joined substrings that must appear in the response body. */
  containsText: string;
  jsonPath: string;
  jsonPathOperator: 'equals' | 'not_equals' | 'contains' | 'exists';
  expectedValue: string;
  /** Short hint shown under the preset selector. */
  hint: string;
}

const CANARY_PROMPT = 'Reply with the single word PONG.';

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    url: 'api.anthropic.com/v1/messages',
    httpMethod: 'POST',
    requestHeaders: [
      'x-api-key: YOUR_API_KEY',
      'anthropic-version: 2023-06-01',
      'content-type: application/json',
    ].join('\n'),
    requestBody: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 16,
      messages: [{ role: 'user', content: CANARY_PROMPT }],
    }),
    expectedStatusCodes: '200',
    containsText: 'PONG',
    jsonPath: '$.model',
    jsonPathOperator: 'contains',
    expectedValue: 'claude-opus-4-8',
    hint: 'Messages API. Replace YOUR_API_KEY with an Anthropic key. Asserts the served model still matches.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    url: 'api.openai.com/v1/chat/completions',
    httpMethod: 'POST',
    requestHeaders: ['Authorization: Bearer YOUR_API_KEY', 'content-type: application/json'].join('\n'),
    requestBody: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 16,
      messages: [{ role: 'user', content: CANARY_PROMPT }],
    }),
    expectedStatusCodes: '200',
    containsText: 'PONG',
    jsonPath: '$.model',
    jsonPathOperator: 'contains',
    expectedValue: 'gpt-4o',
    hint: 'Chat Completions API. Replace YOUR_API_KEY with an OpenAI key.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    url: 'generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    httpMethod: 'POST',
    requestHeaders: ['x-goog-api-key: YOUR_API_KEY', 'content-type: application/json'].join('\n'),
    requestBody: JSON.stringify({
      contents: [{ parts: [{ text: CANARY_PROMPT }] }],
    }),
    expectedStatusCodes: '200',
    containsText: 'PONG',
    jsonPath: '$.candidates[0].content.parts[0].text',
    jsonPathOperator: 'contains',
    expectedValue: 'PONG',
    hint: 'generateContent API. Replace YOUR_API_KEY with a Google AI Studio key.',
  },
  {
    id: 'custom',
    label: 'OpenAI-compatible',
    url: 'your-endpoint.example.com/v1/chat/completions',
    httpMethod: 'POST',
    requestHeaders: ['Authorization: Bearer YOUR_API_KEY', 'content-type: application/json'].join('\n'),
    requestBody: JSON.stringify({
      model: 'your-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: CANARY_PROMPT }],
    }),
    expectedStatusCodes: '200',
    containsText: 'PONG',
    jsonPath: '$.choices[0].message.content',
    jsonPathOperator: 'contains',
    expectedValue: 'PONG',
    hint: 'For OpenRouter, Together, Groq, Ollama, Azure OpenAI, vLLM — anything that speaks the OpenAI schema.',
  },
];

export const getLlmPreset = (id: string): LlmPreset | undefined =>
  LLM_PRESETS.find((p) => p.id === id);
