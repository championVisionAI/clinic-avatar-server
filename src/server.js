import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk';
import {
  GENERAL_QUESTIONS,
  buildQuestionSet,
  GREETING,
  CLOSING,
  TREATMENT_LABELS,
  SEVERITY,
} from './questions.js';

dotenv.config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// In-memory session store
const sessions = new Map();

// ─── Helper Functions ─────────────────────────────────────────────────────────
function validateName(name) {
  if (!name || typeof name !== 'string') return null;
  const cleaned = name.trim();
  const nameRegex = /^[a-zA-Z\s\-']{2,50}$/;
  if (!nameRegex.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function isYesAnswer(answer) {
  const lower = String(answer).toLowerCase().trim();
  const answers = ['yes', 'yep', 'yeah', 'sure', 'true', 'affirmative', 'indeed'];
  let yes_status = false;
  for (const ans of answers) {
    if (lower.includes(ans)) {
      yes_status = true;
      break;
    }
  }
  console.log('Checking if answer is yes:', yes_status);
  console.log('Is yes answer:', ['yes'].includes(lower));
  return yes_status;
}

// ─── Unified LLM-based validation for ALL questions (7-phase flow support) ────
async function validateAnswerCompleteness(questionText, answer, questionKey) {
  try {
    const validationPrompt = `You are a medical intake assistant validating patient responses.

Question asked: "${questionText}"
Patient answered: "${answer}"

Your task: Determine if this answer contains all the necessary information to properly record the response.

Return a JSON object with this exact structure:
{
  "validate": true or false,
  "follow_up": "question here"
}

RULES:
- For name questions: Check if a valid first and last name is provided
- For date questions: Check if a enough date or age is provided
- For yes/no questions: Check if they clearly said yes/no and for HIGH severity questions, if they provided what was asked about
- For open-ended: Check if enough, enough info are provided, not need detailed (include vague answers)
- If validate=true: follow_up should be a confirmation question like "So [extracted_info], is that correct?"
- If validate=false: follow_up should ask for the missing enough information

Examples:
- Q: "What's your name?" A: "John" → validate: false, follow_up: "Could you also provide your last name?"
- Q: "What's your name?" A: "John Smith" → validate: true, follow_up: "John Smith, is that correct?"
- Q: "Are you taking medications?" A: "Yes" → validate: false, follow_up: "What medications are you taking?"
- Q: "Are you taking medications?" A: "Yes, aspirin 100mg daily" → validate: true, follow_up: "So you're taking aspirin 100mg daily, is that correct?"

Return ONLY valid JSON, no other text.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: validationPrompt }],
      max_tokens: 200,
      temperature: 0.2,
    });

    const jsonResponse = response.choices[0].message.content.trim();
    const parsed = JSON.parse(jsonResponse);

    return {
      isValid: parsed.validate === true,
      followUp: parsed.follow_up || 'Please provide more details',
    };
  } catch (err) {
    console.error('Answer validation error:', err);
    // Fallback: basic content check
    const hasContent = answer && String(answer).trim().length > 2;
    return {
      isValid: hasContent,
      followUp: hasContent ? `Is "${answer}" correct?` : 'Could you please answer the question?',
    };
  }
}


// ─── REST: Create a new intake session ───────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  const { treatments } = req.body;
  if (!treatments || !Array.isArray(treatments) || treatments.length === 0) {
    return res.status(400).json({ error: 'treatments array is required' });
  }

  const sessionId = uuidv4();
  const treatmentQuestions = buildQuestionSet(treatments);
  const allQuestions = [...GENERAL_QUESTIONS, ...treatmentQuestions];

  sessions.set(sessionId, {
    id: sessionId,
    treatments,
    questions: allQuestions,
    answers: {},
    currentIndex: -1, // -1 = greeting not yet sent
    state: 'greeting', // greeting | questioning | complete
    createdAt: new Date(),
  });

  res.json({
    sessionId,
    totalQuestions: allQuestions.length,
    treatments,
  });
});

// ─── REST: Get next question / current state ─────────────────────────────────
app.get('/api/sessions/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    sessionId: session.id,
    state: session.state,
    currentIndex: session.currentIndex,
    totalQuestions: session.questions.length,
    answers: session.answers,
  });
});

// ─── REST: Submit an answer and get the next question ────────────────────────
// 7-PHASE VALIDATION FLOW FOR ALL QUESTIONS:
// 1) VALIDATE: Check if answer is complete using OpenAI → valid: true/false
// 2) If invalid (false) → go to PHASE 6 (ask for correct info)
// 3) If valid (true) → go to PHASE 4 (ask confirmation)
// 4) CONFIRM: Ask "is this correct?"
// 5) CHECK CONFIRMATION: If yes → go to PHASE 7 (next question), If no → go to PHASE 6
// 6) REQUEST INFO: Ask follow-up question → go back to PHASE 1
// 7) ADVANCE: Move to next question
app.post('/api/sessions/:sessionId/answer', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { answer, rawTranscript } = req.body;

  if (session.currentIndex < 0 || session.currentIndex >= session.questions.length) {
    return res.status(400).json({ error: 'Invalid question index' });
  }

  const currentQ = session.questions[session.currentIndex];
  const questionKey = currentQ.key;

  // ─── PHASE 5: Check if answer is confirming a previous validation ────────
  if (session.validationState?.[questionKey]?.stage === 'awaiting_confirmation') {
    const isConfirmed = isYesAnswer(answer);

    if (isConfirmed) {
      // ─── PHASE 7: Answer confirmed, store and advance ────────────────────
      session.answers[questionKey] = {
        question: currentQ.text,
        answer: session.validationState[questionKey].answer,
        rawTranscript: session.validationState[questionKey].rawTranscript,
        timestamp: new Date(),
        validated: true,
      };
      // Clean up validation state
      delete session.validationState[questionKey];

      // Advance to next question
      session.currentIndex++;

      if (session.currentIndex >= session.questions.length) {
        session.state = 'final_comments';
        return res.json({
          state: 'final_comments',
          question: 'Is there anything else you would like to add or clarify about your health before we wrap up?',
          progress: {
            current: session.questions.length,
            total: session.questions.length,
          },
        });
      }

      const nextQ = session.questions[session.currentIndex];
      const conversationalQ = await rephraseQuestion(nextQ.text, answer, session, nextQ.severity);

      return res.json({
        state: 'questioning',
        question: conversationalQ,
        questionKey: nextQ.key,
        progress: {
          current: session.currentIndex + 1,
          total: session.questions.length,
        },
      });
    } else {
      // ─── PHASE 6: Not confirmed, ask for correct info again ──────────────
      delete session.validationState[questionKey];
      
      return res.json({
        state: 'questioning',
        question: session.validationState?.[questionKey]?.followUp || `Let me ask again: ${currentQ.text}`,
        questionKey,
        isFollowUp: true,
        progress: {
          current: session.currentIndex + 1,
          total: session.questions.length,
        },
      });
    }
  }

  // ─── PHASE 1: Validate answer completeness ───────────────────────────────
  const validation = await validateAnswerCompleteness(currentQ.text, answer, questionKey);

  if (!validation.isValid) {
    // ─── PHASE 6: Store state for follow-up and ask for correct info ────────
    if (!session.validationState) {
      session.validationState = {};
    }
    session.validationState[questionKey] = {
      stage: 'awaiting_followup_answer',
      answer,
      rawTranscript,
      followUp: validation.followUp,
    };

    return res.json({
      state: 'questioning',
      question: validation.followUp,
      questionKey,
      isFollowUp: true,
      progress: {
        current: session.currentIndex + 1,
        total: session.questions.length,
      },
    });
  }

  // At this point, validate is true
  // ─── PHASE 4: Ask for confirmation ───────────────────────────────────────
  if (!session.validationState) {
    session.validationState = {};
  }
  session.validationState[questionKey] = {
    stage: 'awaiting_confirmation',
    answer,
    rawTranscript,
    followUp: validation.followUp,
  };

  return res.json({
    state: 'questioning',
    question: validation.followUp, // This is the confirmation question
    questionKey,
    isConfirmation: true,
    progress: {
      current: session.currentIndex + 1,
      total: session.questions.length,
    },
  });
});

// ─── REST: Get greeting ───────────────────────────────────────────────────────
app.get('/api/sessions/:sessionId/greeting', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const treatmentNames = session.treatments.map(t => TREATMENT_LABELS[t] || t).join(', ');

  res.json({
    message: GREETING,
    treatments: treatmentNames,
  });
});

// ─── REST: Get summary (for provider) ────────────────────────────────────────
app.get('/api/sessions/:sessionId/summary', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json(buildSummary(session));
});

// ─── REST: Submit final comments and complete ────────────────────────────────
app.post('/api/sessions/:sessionId/final-comments', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { finalComments } = req.body;

  if (finalComments && finalComments.trim()) {
    session.finalComments = {
      text: finalComments,
      timestamp: new Date(),
    };
  }

  session.state = 'complete';

  res.json({
    state: 'complete',
    message: CLOSING,
    summary: buildSummary(session),
  });
});

// ─── REST: Get first question (advance from greeting) ────────────────────────
app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.currentIndex = 0;
  session.state = 'questioning';
  const firstQ = session.questions[0];

  res.json({
    state: 'questioning',
    question: firstQ.text,
    questionKey: firstQ.key,
    progress: { current: 1, total: session.questions.length },
  });
});

// ─── WebSocket: Deepgram real-time transcription proxy ───────────────────────
wss.on('connection', (ws) => {
  console.log('WebSocket client connected for transcription');

  let dgConnection = null;

  ws.on('message', async (data) => {
    try {
      // If it's a string, it's a control message
      if (typeof data === 'string' || data.toString().startsWith('{')) {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'start_transcription') {
          // Open a Deepgram live connection
          dgConnection = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-US',
            smart_format: true,
            interim_results: true,
            utterance_end_ms: 1500,
            vad_events: true,
          });

          dgConnection.on('open', () => {
            console.log('Deepgram connection opened');
            ws.send(JSON.stringify({ type: 'transcription_ready' }));
          });

          dgConnection.on('SpeechStarted', () => {
            ws.send(JSON.stringify({ type: 'speech_started' }));
          });

          dgConnection.on('Results', (result) => {
            const transcript = result.channel?.alternatives?.[0]?.transcript || '';
            const isFinal = result.is_final;
            ws.send(JSON.stringify({ type: 'transcript', transcript, isFinal }));
          });

          dgConnection.on('UtteranceEnd', () => {
            ws.send(JSON.stringify({ type: 'utterance_end' }));
          });

          dgConnection.on('error', (err) => {
            console.error('Deepgram error:', err);
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          });
        }

        if (msg.type === 'stop_transcription' && dgConnection) {
          dgConnection.finish();
          dgConnection = null;
        }

        return;
      }

      // Binary = audio chunk → forward to Deepgram
      if (dgConnection && dgConnection.getReadyState() === 1) {
        dgConnection.send(data);
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => {
    if (dgConnection) {
      dgConnection.finish();
      dgConnection = null;
    }
    console.log('WebSocket client disconnected');
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function rephraseQuestion(questionText, previousAnswer, session, severity = SEVERITY.MEDIUM) {
  try {
    const toneGuidance = {
      [SEVERITY.LOW]: `You are friendly and conversational. Acknowledge the answer briefly and move forward naturally.
CRITICAL: DO NOT use acknowledgment phrases like "thank you", "good to know", "sounds good", "glad you mentioned", "appreciate that", "that's helpful", "got it", "cool", or "nice".
Instead say: "I see", "Understood", "Got that", "I've noted that", or simply transition to the next question.`,
      [SEVERITY.MEDIUM]: `You are professional and warm. Ask naturally without over-reacting.
CRITICAL: DO NOT use acknowledgment phrases like "thank you", "good to know", "sounds good", "glad you mentioned", "appreciate that", "that's helpful".
Instead say: "I see", "Understood", "I've noted that", or transition directly to the next question.`,
      [SEVERITY.HIGH]: `You are professional and neutral. Do NOT comment on the severity or importance of what was shared.
CRITICAL: NEVER use phrases like "thank you", "good to know", "glad you mentioned", "sounds good", "appreciate that", "that's helpful", "thanks for sharing".
CRITICAL: Do NOT use phrases like "approved", "eligible", "qualified", "cleared", "good candidate".
Instead use: "I've noted that", "I see", "Understood", "Got that", or transition directly to the next question without commentary.
Keep response brief and factual without emotional validation.`,
    };

    const system = `You are a warm, professional medical intake assistant. Your role is to gather accurate health information.
${toneGuidance[severity] || toneGuidance[SEVERITY.MEDIUM]}

RULES:
- Ask ONE question at a time
- Never interpret answers clinically
- Never provide medical advice or commentary
- Keep it brief and natural — 1-2 sentences max
- Do not add unnecessary commentary or reactions
- Transition smoothly to the next question`;

    const prompt = previousAnswer
      ? `The patient just answered: "${previousAnswer}". Now ask this next question naturally: "${questionText}"`
      : `Ask this question naturally: "${questionText}"`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: 100,
      temperature: severity === SEVERITY.HIGH ? 0.3 : 0.5,
    });

    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error('OpenAI rephrase error:', err);
    return questionText;
  }
}

function buildSummary(session) {
  const treatmentNames = session.treatments.map(t => TREATMENT_LABELS[t] || t);

  return {
    sessionId: session.id,
    generatedAt: new Date(),
    treatments: treatmentNames,
    patientInfo: {
      name: session.answers.full_name?.answer || 'Not provided',
      dateOfBirth: session.answers.date_of_birth?.answer || 'Not provided',
    },
    responses: Object.entries(session.answers).map(([key, val]) => ({
      key,
      question: val.question,
      answer: val.answer,
      followUpAnswer: val.followUpAnswer || null,
      timestamp: val.timestamp,
      validated: val.validated || false,
    })),
    finalComments: session.finalComments?.text || null,
    totalQuestions: session.questions.length,
    answeredQuestions: Object.keys(session.answers).length,
  };
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});
