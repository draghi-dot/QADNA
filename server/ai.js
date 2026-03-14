/**
 * AI-powered audit report generation via GLM-5 on Featherless API.
 * Uses the OpenAI-compatible SDK to request a structured JSON analysis
 * of static scan findings.
 *
 * Exports:
 *   generateAIReport(repoName, scanResult)          — non-streaming (legacy)
 *   analyzeWithStream(repoName, scanResult, onChunk) — streaming with SSE callback
 */

import OpenAI from 'openai'

const openai = new OpenAI({
  baseURL: 'https://api.featherless.ai/v1',
  apiKey: 'rc_22250c67de3c61dd84d6ef100e62e37a37991bae06be0510829b73ac29b903f5',
})

const MODEL = 'zai-org/GLM-5'

/**
 * Fallback report when the AI call fails or returns unparseable output.
 * @param {{ findings: object[], summary: object }} scanResult
 * @returns {object}
 */
function buildFallbackReport(scanResult) {
  const { summary, findings } = scanResult
  const total = Object.values(summary).reduce((a, b) => a + b, 0)

  let overallRating = 'Secure'
  if (summary.critical > 0) overallRating = 'Critical'
  else if (summary.high > 5) overallRating = 'Vulnerable'
  else if (summary.high > 0 || summary.medium > 3) overallRating = 'Needs Attention'

  const riskScore = Math.min(
    100,
    summary.critical * 25 + summary.high * 10 + summary.medium * 4 + summary.low * 1,
  )

  // Group findings by category
  const categoryMap = {}
  for (const f of findings) {
    if (!categoryMap[f.category]) {
      categoryMap[f.category] = { count: 0, severity: f.severity }
    }
    categoryMap[f.category].count++
  }

  const categories = Object.entries(categoryMap).map(([name, { count, severity }]) => ({
    name,
    severity,
    count,
    explanation: `${count} instance(s) detected.`,
    remediation: 'Review each flagged location and apply appropriate fixes.',
  }))

  return {
    overallRating,
    executiveSummary: `Static analysis found ${total} issue(s) across ${Object.keys(categoryMap).length} category(ies). Manual review is recommended for all flagged items.`,
    riskScore,
    categories,
    generatedByFallback: true,
  }
}

/**
 * Build the shared prompt used by both the streaming and non-streaming paths.
 * @param {string} repoName
 * @param {{ findings: object[], summary: object }} scanResult
 * @returns {{ systemMessage: string, userPrompt: string, condensed: object[] }}
 */
function buildPromptParts(repoName, scanResult) {
  const { findings, summary } = scanResult

  const condensed = findings.slice(0, 80).map((f) => ({
    category: f.category,
    severity: f.severity,
    file: f.file,
    line: f.line,
    description: f.description,
    snippet: f.snippet?.slice(0, 80),
  }))

  const systemMessage = 'You are a security analysis assistant. Always respond with valid JSON only — no markdown, no explanation, no code fences.'

  const userPrompt = `You are a senior security engineer. Analyze these findings from a static code audit of the GitHub repository "${repoName}" and produce a JSON response with EXACTLY this structure (no extra text, no markdown fences, just the JSON object):

{
  "overallRating": "Critical|Vulnerable|Needs Attention|Secure",
  "executiveSummary": "2-3 sentence plain-English summary of the security posture",
  "riskScore": <integer 0-100>,
  "categories": [
    {
      "name": "<category name>",
      "severity": "critical|high|medium|low",
      "count": <integer>,
      "explanation": "<why this is a risk>",
      "remediation": "<specific steps to fix>"
    }
  ]
}

Summary counts: critical=${summary.critical}, high=${summary.high}, medium=${summary.medium}, low=${summary.low}

Findings (up to 80 shown):
${JSON.stringify(condensed, null, 2)}`

  return { systemMessage, userPrompt, condensed }
}

/**
 * Parse the final accumulated text from an AI response into a report object.
 * Strips markdown fences and validates required fields.
 * Falls back to buildFallbackReport on failure.
 * @param {string} rawText
 * @param {{ findings: object[], summary: object }} scanResult
 * @returns {object}
 */
function parseAccumulatedResponse(rawText, scanResult) {
  try {
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
    const parsed = JSON.parse(cleaned)
    if (!parsed.overallRating || !parsed.executiveSummary || typeof parsed.riskScore !== 'number') {
      throw new Error('Missing required fields in AI response')
    }
    return parsed
  } catch (err) {
    console.error('[AI] Failed to parse accumulated response, using fallback.', err.message)
    if (rawText) console.error('[AI] Raw content was:', rawText.slice(0, 300))
    return buildFallbackReport(scanResult)
  }
}

/**
 * Send scan findings to GLM-5 and receive a structured JSON audit report.
 * @param {string} repoName  Display name of the repository (e.g. "owner/repo").
 * @param {{ findings: object[], summary: object }} scanResult
 * @returns {Promise<object>}  Parsed AI report JSON.
 */
export async function generateAIReport(repoName, scanResult) {
  const { findings } = scanResult

  if (findings.length === 0) {
    return {
      overallRating: 'Secure',
      executiveSummary: `No security issues were detected in ${repoName} during static analysis. The codebase appears to follow secure coding practices for the patterns checked.`,
      riskScore: 0,
      categories: [],
    }
  }

  const { systemMessage, userPrompt } = buildPromptParts(repoName, scanResult)

  let rawContent = ''
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.2,
    })

    rawContent = response.choices?.[0]?.message?.content ?? ''
    console.log(`[AI] Token usage: prompt=${response.usage?.prompt_tokens}, completion=${response.usage?.completion_tokens}`)

    return parseAccumulatedResponse(rawContent, scanResult)
  } catch (err) {
    console.error('[AI] Failed to parse AI response, using fallback.', err.message)
    if (rawContent) console.error('[AI] Raw content was:', rawContent.slice(0, 300))
    return buildFallbackReport(scanResult)
  }
}

/**
 * Stream GLM-5 reasoning and content tokens to a callback, then return the
 * parsed report object once the stream completes.
 *
 * The callback receives each text fragment as it arrives. The model may
 * surface reasoning tokens via `delta.reasoning_content` (DeepSeek-style
 * thinking models); we fall back to `delta.content` when that field is absent
 * so the streaming display still works with standard chat models.
 *
 * @param {string} repoName  Display name of the repository (e.g. "owner/repo").
 * @param {{ findings: object[], summary: object }} scanResult
 * @param {(text: string) => void} onChunk  Called for each streamed text fragment.
 * @returns {Promise<object>}  Parsed AI report JSON.
 */
export async function analyzeWithStream(repoName, scanResult, onChunk) {
  const { findings } = scanResult

  if (findings.length === 0) {
    return {
      overallRating: 'Secure',
      executiveSummary: `No security issues were detected in ${repoName} during static analysis. The codebase appears to follow secure coding practices for the patterns checked.`,
      riskScore: 0,
      categories: [],
    }
  }

  const { systemMessage, userPrompt } = buildPromptParts(repoName, scanResult)

  let accumulatedContent = ''
  let accumulatedReasoning = ''

  try {
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.2,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta

      if (!delta) continue

      // Prefer reasoning_content (thinking models like DeepSeek / GLM with CoT)
      if (delta.reasoning_content) {
        accumulatedReasoning += delta.reasoning_content
        onChunk(delta.reasoning_content)
      } else if (delta.content) {
        // If we have already received some reasoning, don't also stream the
        // final JSON output — the caller only wants the thinking phase.
        // But if no reasoning tokens arrived at all, stream the content so
        // the UI shows something meaningful.
        if (accumulatedReasoning.length === 0) {
          onChunk(delta.content)
        }
        accumulatedContent += delta.content
      }
    }

    console.log(`[AI:stream] Reasoning tokens: ${accumulatedReasoning.length} chars, content: ${accumulatedContent.length} chars`)
  } catch (err) {
    console.error('[AI:stream] Streaming error:', err.message)
    // Fall through — attempt to parse whatever we accumulated, then fallback
  }

  return parseAccumulatedResponse(accumulatedContent, scanResult)
}
