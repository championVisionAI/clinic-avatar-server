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
app.post('/api/sessions/:sessionId/answer', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { answer, rawTranscript } = req.body;

  // Save current answer
  if (session.currentIndex >= 0 && session.currentIndex < session.questions.length) {
    const currentQ = session.questions[session.currentIndex];
    session.answers[currentQ.key] = {
      question: currentQ.text,
      answer,
      rawTranscript,
      timestamp: new Date(),
    };
  }

  // Advance index
  session.currentIndex++;

  // Check if done
  if (session.currentIndex >= session.questions.length) {
    session.state = 'complete';
    return res.json({
      state: 'complete',
      message: CLOSING,
      summary: buildSummary(session),
    });
  }

  // Return next question
  const nextQ = session.questions[session.currentIndex];
  session.state = 'questioning';

  // Use OpenAI to make the question conversational if needed
  const conversationalQ = await rephraseQuestion(nextQ.text, answer, session);

  res.json({
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
async function rephraseQuestion(questionText, previousAnswer, session) {
  try {
    const system = `You are a warm, professional medical intake assistant. 
Your job is to ask health screening questions in a conversational, friendly tone.
RULES:
- Ask ONE question at a time
- Never interpret answers clinically
- Never use words like "approved", "eligible", "qualified", or "cleared"
- Keep it brief and natural — 1-2 sentences max
- Do not add commentary about the previous answer beyond a brief acknowledgment if natural`;

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
      temperature: 0.7,
    });

    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error('OpenAI rephrase error:', err);
    return questionText; // fallback to original
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
      timestamp: val.timestamp,
    })),
    totalQuestions: session.questions.length,
    answeredQuestions: Object.keys(session.answers).length,
  };
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});
