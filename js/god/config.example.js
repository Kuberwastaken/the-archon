/**
 * THE ARCHON — config template.
 *
 * Copy this file to `config.local.js` (next to it) and fill in your real
 * Anthropic API key. `config.local.js` is gitignored so the key never leaves
 * your machine.
 *
 * If `config.local.js` is missing, the game will still load (fallback). The
 * Archon will be silent.
 */
window.GOD_CONFIG = {
    // Get a key from https://console.anthropic.com/
    apiKey: "sk-ant-PUT-YOUR-KEY-HERE",

    // Sonnet 4.6 is the recommended model. Tool use must be supported.
    model: "claude-sonnet-4-6",

    // Cap on tokens per intervention. ~512 is plenty for 1-3 tool calls.
    maxTokens: 1024,

    // Master switch. Set false to disable all Archon behavior at runtime.
    enabled: true,

    // After how many waves the Archon awakens. 1 = she watches the first
    // wave silently, then begins meddling between waves 1->2.
    awakenAfterWave: 1,

    // Hard floor on the gap between interventions (ms) so back-to-back
    // wave clears don't spam the API.
    minGapMs: 4000
};
