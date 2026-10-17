// Claude stage: the parts of the job that need reading and judgment rather than measurement.
// 1. planClass: an instructor describes the class in their own words; Claude turns that into the
//    session settings (favorites, age range, steady or drill, pace if they gave one) and says what it understood.
// 2. briefWalk: after the songs are chosen, Claude reads the outcome (what was kept, what was refused and why)
//    and writes a short note for the instructor, with at most one concrete adjustment they can apply.
// Qloo decides taste and the tempo rules decide safety; Claude never adds a song or overrides a rule.
const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

export const claudeAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);
// The last failure, kept so /api/features can show why without anyone reading server logs.
export let lastClaudeError = null;

async function callTool({ system, user, tool, maxTokens = 800 }) {
  const res = await fetch(API, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system,
      tools: [tool], tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const msg = `Claude ${res.status}: ${(await res.text()).slice(0, 300)}`;
    lastClaudeError = { at: new Date().toISOString(), msg };
    throw new Error(msg);
  }
  lastClaudeError = null;
  const body = await res.json();
  const block = body.content?.find(b => b.type === 'tool_use');
  if (!block) throw new Error('Claude returned no plan');
  return block.input;
}

const PLAN_TOOL = {
  name: 'set_up_session',
  description: 'Settings for one Second Wind music session, taken from the instructor\'s description.',
  input_schema: {
    type: 'object',
    properties: {
      favorites: {
        type: 'array', maxItems: 4, items: { type: 'string' },
        description: 'One to four real recording artists that best represent what this class loves, spelled as the artist is credited. When the description names more than four, or names genres or eras instead of artists, choose artists that together cover the range, giving weight to what most of the class likes and keeping one slot for a strong individual favorite if mentioned.',
      },
      age: { type: 'string', enum: ['55_and_older', '36_to_55', '35_and_younger'], description: 'Age range of most of the class. Default 55_and_older for Parkinson\'s classes unless stated otherwise.' },
      mode: { type: 'string', enum: ['steady', 'drill'], description: 'drill when the instructor wants planned changes in pace, style or volume (dual-task or cognitive work, "keep them on their toes", switching songs on them); otherwise steady.' },
      pace: { type: 'integer', description: 'Steps per minute, only if the instructor states a number or a cadence target. Never guess from words like slow or brisk; leave it out instead.' },
      understood: { type: 'string', description: 'One or two plain sentences, addressed to the instructor, saying what you set up and why, including how you covered the class with only four artists. No medical claims.' },
      check: { type: 'string', description: 'One short question for the instructor, only if something important is unclear or a safety concern is mentioned (for example freezing, falls, or a walker with a cane). Leave it out otherwise.' },
    },
    required: ['favorites', 'age', 'mode', 'understood'],
  },
};

export async function planClass(description) {
  const system = 'You set up Second Wind, a tool that builds walking music for Parkinson\'s exercise classes from the music the class loves. '
    + 'An instructor describes their class in their own words. Read it like an experienced music therapist would and fill in the session settings. '
    + 'Choose artists from what the instructor actually said; do not add your own taste. Write plainly, no jargon, no dashes.';
  return callTool({ system, user: `The instructor wrote:\n\n${description}`, tool: PLAN_TOOL });
}

const BRIEF_TOOL = {
  name: 'brief_the_instructor',
  description: 'A short note to the instructor about the walk that was just built, and at most one adjustment.',
  input_schema: {
    type: 'object',
    properties: {
      brief: { type: 'string', description: 'Two or three plain sentences for the instructor: what the class will hear, and anything notable about what was refused and why (for example a favorite whose songs mostly sway or run slower than the pace). Mention specific songs or artists. No medical claims, no dashes.' },
      adjustment: {
        type: 'object',
        description: 'One change worth trying. Leave it out when the walk is already a good fit. Only suggest something the tool can do: a pace a few steps different that would let a favorite in, switching steady and drill, or swapping in a named artist from the same era.',
        properties: {
          label: { type: 'string', description: 'Button text, under 8 words, e.g. "Try 96 steps to include Patsy Cline".' },
          pace: { type: 'integer', description: 'New pace, if the change is a pace.' },
          mode: { type: 'string', enum: ['steady', 'drill'], description: 'New walk type, if the change is a walk type.' },
          addArtist: { type: 'string', description: 'Artist to add, if the change adds one.' },
        },
        required: ['label'],
      },
    },
    required: ['brief'],
  },
};

export async function briefWalk({ target, mode, favorites, result }) {
  const reasons = {};
  for (const t of result.held) reasons[t.reason] = (reasons[t.reason] || []).concat(`${t.title} (${t.artist})`);
  const slowFast = result.outOfRange.filter(t => favorites.includes(t.artist))
    .map(t => `${t.title} (${t.artist}): ${Math.round(t.bpm)} BPM`);
  const facts = {
    pace: target, mode, favorites, counts: result.counts,
    kept: result.playlist.map(t => `${t.title} (${t.artist}) at ${Math.round(t.step)} steps${t.cue ? `, cue: ${t.cue.text}` : ''}`),
    heldOut: reasons,
    favoritesSongsOutsidePace: slowFast,
    favoriteNotes: result.favoriteNotes.map(n => n.note),
  };
  const system = 'You are the music therapist reviewing a walking playlist that Second Wind built for a Parkinson\'s exercise class. '
    + 'The tempo rules are fixed and correct: never suggest adding a song that was held out for sway. '
    + 'Write for a busy instructor about to start class. Be specific and brief.';
  return callTool({ system, user: `Here is what was built:\n${JSON.stringify(facts, null, 1)}`, tool: BRIEF_TOOL, maxTokens: 600 });
}
