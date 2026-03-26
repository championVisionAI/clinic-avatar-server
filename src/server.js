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
  const answers = ['yes', 'yep', 'yeah', 'sure', 'true', 'affirmative', 'indeed', 'correct', 'right'];
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
// Validates answer completeness considering main question + all accumulated follow-up answers
async function validateAnswerCompleteness(questionText, answer, questionKey, allPreviousAnswers = []) {
  try {
    // Build context from all previous answers for this question
    let contextStr = '';
    if (allPreviousAnswers.length > 0) {
      contextStr = '\n\nPrevious answers in this question:\n';
      allPreviousAnswers.forEach((prev, idx) => {
        contextStr += `${idx + 1}. ${prev}\n`;
      });
      contextStr += `\nNew answer: ${answer}`;
    }
    console.log('Validating answer completeness with context:', { questionText, answer, questionKey, allPreviousAnswers });
    const validationPrompt = `You are a medical intake assistant validating patient responses. BE STRICT about requiring sufficient information.

Question asked: "${questionText}"
Patient answered: "${answer}"${contextStr}

Your task: Determine if this answer (combined with all previous answers) contains SUFFICIENT information to properly record the response for a medical provider.

Return a JSON object with this exact structure:
{
  "validate": true or false,
  "follow_up": "question here (only if validate is false)"
}

STRICT VALIDATION RULES:
- For name questions: MUST have both first AND last name explicitly stated
- For date questions: MUST have specific date (day/month/year) or clear age. Vague dates like "a while ago" NOT acceptable
- For yes/no with details: YES without specifics = validate: false. Need specific details
- For medications: MUST have name AND dosage AND frequency
  * "I take medication" = NOT VALID (need specific names)
  * "Aspirin" = NOT VALID (need dosage and frequency)
  * "Aspirin 100mg daily" = VALID
- For allergies: MUST have specific allergen explicitly named
  * "I have allergies" = NOT VALID (which allergen?)
  * "Penicillin allergy" = VALID
- For medical conditions: MUST name the specific condition, not vague
  * "Some medical stuff" = NOT VALID
  * "Mild allergies, high blood pressure" = VALID
- For surgeries: MUST name the type, not just "surgery"
  * "I had surgery" = NOT VALID
  * "Appendectomy in 2020" = VALID
- CRITICAL: Negative answers ("No", "Don't have", "Never") = validate: true
- CRITICAL: "I don't know", "I don't remember", "I'm not sure" = validate: true
- CRITICAL: Refusal to answer = validate: true
- Garbled with ZERO extractable meaning = validate: false
- Vague/generic without specifics = validate: false

Invalid examples:
- A: "Some medicine" → validate: false
- A: "I have allergies" → validate: false
- A: "Yeah, surgery" → validate: false
- A: "Maybe something" → validate: false

Valid examples:
- A: "No" → validate: true
- A: "I don't remember exactly" → validate: true
- A: "Metformin 500mg twice daily" → validate: true
- A: "Penicillin causes rash" → validate: true

Return ONLY valid JSON.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: validationPrompt }],
      max_tokens: 200,
      temperature: 0.1,
    });
    const jsonResponse = response.choices[0].message.content.trim();
    const parsed = JSON.parse(jsonResponse);

    return {
      isValid: parsed.validate === true,
      followUp: parsed.follow_up || null,
    };
  } catch (err) {
    console.error('Answer validation error:', err);
    // Fallback: require meaningful content
    const hasContent = answer && String(answer).trim().length > 5;
    return {
      isValid: false,
      followUp: 'Could you provide more specific details?',
    };
  }
}

// ─── Generate creative, varied follow-up questions using LLM ──────────────────
async function generateCreativeFollowUp(questionText, answer, questionKey, followUpAttempt = 1) {
  try {
    let attemptContext = '';
    if (followUpAttempt > 1) {
      attemptContext = `\n\nThis is follow-up attempt #${followUpAttempt}. The patient already answered once. Ask the same thing but in a different way - maybe ask about a specific detail they missed, or rephrase to focus on what's most important. Sound like a real healthcare provider asking a clarifying question.`;
    }

    const followUpPrompt = `You are a nurse practitioner asking a clarifying follow-up question.

Original question: "${questionText}"
Patient's answer: "${answer}"${attemptContext}

Generate ONE natural, conversational follow-up question that:
- Sounds like how a real nurse would ask (not robotic)
- Is specific and focuses on what detail or clarity is missing
- Uses natural language like real healthcare providers in medical calls
- If first attempt: asks for the missing detail naturally
- If second+ attempt: asks the same thing differently, maybe focusing on one specific aspect

Examples of natural follow-ups:
- "Tell me a bit more about that"
- "What medication are you taking, and do you know the dosage?"
- "When did you have that surgery?"
- "Which specific medication caused the reaction?"

Return ONLY the follow-up question. No prefix, no explanation.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: followUpPrompt }],
      temperature: 0.7, // Higher temperature for more creative variation
    });

    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error('Follow-up generation error:', err);
    // Fallback generic follow-up
    return `Tell me a bit more about that.`;
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
// SIMPLIFIED 3-PHASE VALIDATION FLOW (NO CONFIRMATION):
// 1) VALIDATE: Check if answer (+ all previous follow-ups) is complete → valid: true/false
//    - If valid → PHASE 7 (advance to next question)
//    - If not valid → PHASE 6 (ask follow-up)
// 6) REQUEST INFO: Ask follow-up question (MAX 2 attempts) → accumulate answers and loop back to PHASE 1
//    - After 2 follow-up attempts, force proceed to PHASE 7
// 7) ADVANCE: Store answer and move to next question
app.post('/api/sessions/:sessionId/answer', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { answer, rawTranscript } = req.body;

  // ─── SPECIAL CASE: Handle final comments ─────────────────────────────────
  if (session.state === 'final_comments') {
    if (answer && answer.trim()) {
      session.finalComments = {
        text: answer,
        timestamp: new Date(),
      };
    }

    session.state = 'complete';

    return res.json({
      state: 'complete',
      message: CLOSING,
      summary: buildSummary(session),
    });
  }

  if (session.currentIndex < 0 || session.currentIndex >= session.questions.length) {
    return res.status(400).json({ error: 'Invalid question index' });
  }

  const currentQ = session.questions[session.currentIndex];
  const questionKey = currentQ.key;

  // Initialize validation state for this question if not exists
  if (!session.validationState) {
    session.validationState = {};
  }
  if (!session.validationState[questionKey]) {
    session.validationState[questionKey] = {
      answers: [], // Accumulate all answers (main + follow-ups)
      rawTranscripts: [],
      followUpAttempts: 0, // Track follow-up attempts
    };
  }

  // Add current answer to accumulated answers
  session.validationState[questionKey].answers.push(answer);
  session.validationState[questionKey].rawTranscripts.push(rawTranscript);

  // Combine all accumulated answers for validation
  const combinedAnswers = session.validationState[questionKey].answers.join(' ');

  // ─── PHASE 1: Validate answer completeness with all accumulated answers ────
  const validation = await validateAnswerCompleteness(
    currentQ.text,
    combinedAnswers,
    questionKey,
    session.validationState[questionKey].answers.slice(0, -1) // Previous answers only
  );

  if (!validation.isValid) {
    // Check if we've already done 2 follow-up attempts
    if (session.validationState[questionKey].followUpAttempts >= 2) {
      // ─── FORCE ADVANCE after 2 follow-up attempts ────────────────────────
      console.log(`Forcing advance for question ${questionKey} after 2 follow-up attempts`);
      
      session.answers[questionKey] = {
        question: currentQ.text,
        answer: combinedAnswers,
        rawTranscript: session.validationState[questionKey].rawTranscripts.join(' | '),
        timestamp: new Date(),
        validated: true,
        allResponses: session.validationState[questionKey].answers,
        forcedAdvance: true, // Mark that we forced advance due to follow-up limit
      };

      delete session.validationState[questionKey];
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
      const conversationalQ = await rephraseQuestion(nextQ.text, combinedAnswers, session, nextQ.severity);

      return res.json({
        state: 'questioning',
        question: conversationalQ,
        questionKey: nextQ.key,
        progress: {
          current: session.currentIndex + 1,
          total: session.questions.length,
        },
      });
    }

    // ─── PHASE 6: Answer incomplete, generate creative follow-up ──────────────
    session.validationState[questionKey].followUpAttempts++;
    
    const creativeFollowUp = await generateCreativeFollowUp(
      currentQ.text,
      combinedAnswers,
      questionKey,
      session.validationState[questionKey].followUpAttempts
    );

    return res.json({
      state: 'questioning',
      question: creativeFollowUp,
      questionKey,
      isFollowUp: true,
      followUpAttempt: session.validationState[questionKey].followUpAttempts,
      progress: {
        current: session.currentIndex + 1,
        total: session.questions.length,
      },
    });
  }

  // ─── PHASE 7: Answer valid, store and advance to next question ──────────────
  session.answers[questionKey] = {
    question: currentQ.text,
    answer: combinedAnswers,
    rawTranscript: session.validationState[questionKey].rawTranscripts.join(' | '),
    timestamp: new Date(),
    validated: true,
    allResponses: session.validationState[questionKey].answers, // Track individual responses
    followUpAttemptsUsed: session.validationState[questionKey].followUpAttempts,
  };

  // Clean up validation state for this question
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
  const conversationalQ = await rephraseQuestion(nextQ.text, combinedAnswers, session, nextQ.severity);

  return res.json({
    state: 'questioning',
    question: conversationalQ,
    questionKey: nextQ.key,
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
      [SEVERITY.LOW]: `You are friendly and conversational, like a real nurse practitioner.
Use natural acknowledgments: "OK", "Perfect", "Got you", "I see", "All right", "Got that".
Keep it warm but professional. Move forward naturally without over-explaining.`,
      [SEVERITY.MEDIUM]: `You are professional and warm, like a real healthcare provider.
Use natural acknowledgments: "OK", "Perfect", "Got you", "I got that", "I see", "Understood".
Be conversational and natural. Transition smoothly to the next question, sometimes explaining why the information helps.`,
      [SEVERITY.HIGH]: `You are professional and neutral, handling sensitive medical topics carefully.
Use natural acknowledgments: "OK", "Got that", "I see", "Understood", "I've noted that".
Do NOT use: "thank you", "good to know", "glad you mentioned", "sounds good", "appreciate that", "approved", "cleared", "qualified".
Keep it brief and factual. Acknowledge what they said, then move to the next question without judgment or commentary.`,
    };

    const system = `You are a nurse practitioner doing medical clearance intake. You sound natural, warm, and professional - like the real healthcare providers in these transcripts:
- Acknowledge the patient's answer naturally (not robotic)
- Ask the next question conversationally and directly
- One question at a time
- Keep responses brief and natural (1-2 sentences)
- Never provide medical advice
- Sound like a real person, not an AI

${toneGuidance[severity] || toneGuidance[SEVERITY.MEDIUM]}`;

    const prompt = previousAnswer
      ? `Patient answered: "${previousAnswer}"\nNow naturally acknowledge that and ask this next question: "${questionText}"`
      : `Ask this question naturally and directly: "${questionText}"`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
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
