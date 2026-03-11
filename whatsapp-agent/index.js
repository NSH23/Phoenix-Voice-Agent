const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const SUPABASE_URL = 'https://fhhwfqlbgmsscmqihjyz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID || '1023140200877702';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'phoenix_verify_2024';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

// ─────────────────────────────────────────────
// DEDUPLICATION
// ─────────────────────────────────────────────
const processedMessages = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) return true;
  processedMessages.add(msgId);
  if (processedMessages.size > 1000) {
    processedMessages.delete(processedMessages.values().next().value);
  }
  return false;
}

// ─────────────────────────────────────────────
// WHATSAPP SEND
// ─────────────────────────────────────────────
async function sendText(phone, message) {
  try {
    var fullPhone = phone.startsWith('+') ? phone : '+' + phone;
    // Split long messages — WhatsApp has 4096 char limit
    var chunks = splitMessage(message);
    for (var i = 0; i < chunks.length; i++) {
      await axios.post(
        'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
        { messaging_product: 'whatsapp', to: fullPhone, type: 'text', text: { body: chunks[i] } },
        { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
      );
      if (chunks.length > 1) await sleep(500);
    }
    await logOutbound(phone, message);
    console.log('WA sent to', fullPhone);
  } catch (err) {
    console.error('sendText FAILED:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function sendImage(phone, imageUrl, caption) {
  try {
    var fullPhone = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post(
      'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fullPhone, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('sendImage FAILED:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

function splitMessage(text) {
  if (text.length <= 4000) return [text];
  var chunks = [];
  while (text.length > 0) {
    var chunk = text.substring(0, 4000);
    var lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline > 3000) chunk = text.substring(0, lastNewline);
    chunks.push(chunk.trim());
    text = text.substring(chunk.length).trim();
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ─────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────
async function getLead(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { console.error('getLead error:', e.message); return null; }
}

async function upsertLead(phone, name, fields) {
  try {
    var existing = await getLead(phone);
    var now = new Date().toISOString();

    if (!existing) {
      var payload = Object.assign({
        phone, name: name || 'Friend',
        status: 'new', step: 'ai_chat',
        source: 'whatsapp', first_channel: 'whatsapp',
        last_channel: 'whatsapp', whatsapp_count: 1,
        call_count: 0, lead_score: 0,
        last_interaction: now, created_at: now
      }, fields || {});
      await supabase.post('/rest/v1/leads', payload);
      console.log('New lead created:', phone);
    } else {
      var update = Object.assign({
        last_interaction: now,
        last_channel: 'whatsapp',
        whatsapp_count: (existing.whatsapp_count || 0) + 1,
        updated_at: now
      }, fields || {});
      if (name && name !== 'Friend' && !existing.name) update.name = name;
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, update);
    }
  } catch (e) { console.error('upsertLead error:', e.message); }
}

async function incrementLeadScore(phone, amount) {
  try {
    var lead = await getLead(phone);
    if (lead) {
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, {
        lead_score: (lead.lead_score || 0) + amount
      });
    }
  } catch (e) {}
}

async function getConversationHistory(phone) {
  try {
    // Get last 20 messages for context
    var res = await supabase.get(
      '/rest/v1/conversations?lead_phone=eq.' + phone +
      '&channel=eq.whatsapp&order=created_at.desc&limit=20&select=direction,content,created_at'
    );
    if (!res.data || res.data.length === 0) return [];
    // Reverse to chronological order
    return res.data.reverse();
  } catch (e) { return []; }
}

async function logInbound(phone, message, msgId) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'inbound', message_type: 'text',
      content: message, whatsapp_message_id: msgId || '',
      status: 'received', channel: 'whatsapp'
    }, { headers: { Prefer: 'resolution=ignore-duplicates' } });
  } catch (e) {}
}

async function logOutbound(phone, message) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'outbound', message_type: 'text',
      content: message, status: 'sent', channel: 'whatsapp'
    });
  } catch (e) {}
}

async function getKnowledgeBase() {
  try {
    var res = await supabase.get('/rest/v1/knowledge_base?is_active=eq.true&select=category,title,content&order=category.asc');
    return res.data || [];
  } catch (e) { console.error('getKnowledgeBase error:', e.message); return []; }
}

async function getMediaImage(key) {
  try {
    var res = await supabase.get(
      '/rest/v1/workflow_content?content_key=eq.' + key +
      '&is_active=eq.true&select=media_assets(public_url)'
    );
    if (res.data && res.data[0] && res.data[0].media_assets) {
      return res.data[0].media_assets.public_url;
    }
    return null;
  } catch (e) { return null; }
}

// ─────────────────────────────────────────────
// BUILD KNOWLEDGE BASE CONTEXT STRING
// ─────────────────────────────────────────────
function buildKnowledgeContext(kb) {
  if (!kb || kb.length === 0) return '';
  var grouped = {};
  kb.forEach(function(item) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push('## ' + item.title + '\n' + item.content);
  });
  var parts = [];
  Object.keys(grouped).forEach(function(cat) {
    parts.push('### ' + cat.toUpperCase() + '\n' + grouped[cat].join('\n\n'));
  });
  return parts.join('\n\n');
}

// ─────────────────────────────────────────────
// EXTRACT LEAD DATA FROM AI RESPONSE
// ─────────────────────────────────────────────
function extractLeadData(aiText, currentLead) {
  var updates = {};

  // Extract name
  var nameMatch = aiText.match(/\[LEAD:name=([^\]]+)\]/);
  if (nameMatch) updates.name = nameMatch[1].trim();

  // Extract event type
  var eventMatch = aiText.match(/\[LEAD:event_type=([^\]]+)\]/);
  if (eventMatch) updates.event_type = eventMatch[1].trim();

  // Extract venue
  var venueMatch = aiText.match(/\[LEAD:venue=([^\]]+)\]/);
  if (venueMatch) updates.venue = venueMatch[1].trim();

  // Extract guest count
  var guestMatch = aiText.match(/\[LEAD:guest_count=([^\]]+)\]/);
  if (guestMatch) {
    var g = parseInt(guestMatch[1]);
    if (!isNaN(g)) updates.guest_count = g;
  }

  // Extract event date
  var dateMatch = aiText.match(/\[LEAD:event_date=([^\]]+)\]/);
  if (dateMatch) {
    var d = dateMatch[1].trim();
    if (/\d/.test(d)) updates.event_date = d;
  }

  // Extract status upgrade
  var statusMatch = aiText.match(/\[LEAD:status=([^\]]+)\]/);
  if (statusMatch) updates.status = statusMatch[1].trim();

  // Extract score increment
  var scoreMatch = aiText.match(/\[LEAD:score\+(\d+)\]/);
  if (scoreMatch) updates._scoreIncrement = parseInt(scoreMatch[1]);

  // Extract image to send
  var imageMatch = aiText.match(/\[SEND:image=([^\]]+)\]/);
  if (imageMatch) updates._sendImage = imageMatch[1].trim();

  return updates;
}

// Clean AI tags from message before sending to user
function cleanAiTags(text) {
  return text
    .replace(/\[LEAD:[^\]]+\]/g, '')
    .replace(/\[SEND:[^\]]+\]/g, '')
    .trim();
}

// ─────────────────────────────────────────────
// CALL CLAUDE AI
// ─────────────────────────────────────────────
async function callClaude(phone, userMessage, lead, history, knowledgeBase) {
  var kb = buildKnowledgeContext(knowledgeBase);

  var leadContext = '';
  if (lead) {
    leadContext = '\n\nCURRENT LEAD DATA:\n' +
      '- Name: ' + (lead.name || 'Unknown') + '\n' +
      '- Event Type: ' + (lead.event_type || 'Unknown') + '\n' +
      '- Venue: ' + (lead.venue || 'Unknown') + '\n' +
      '- Guest Count: ' + (lead.guest_count || 'Unknown') + '\n' +
      '- Event Date: ' + (lead.event_date || 'Unknown') + '\n' +
      '- Status: ' + (lead.status || 'new') + '\n' +
      '- Lead Score: ' + (lead.lead_score || 0) + '\n' +
      '- Returning customer: Yes, has chatted before';
  } else {
    leadContext = '\n\nCURRENT LEAD DATA: This is a new customer, no data saved yet.';
  }

  var systemPrompt = `You are Aishwarya, a warm, friendly and professional WhatsApp chat assistant for Phoenix Events & Production, Pimpri-Chinchwad, Pune. You chat in a natural, human way — never robotic, never scripted.

LANGUAGE RULES:
- Default to Hindi (Hinglish is fine — mix of Hindi and English is natural)
- If customer writes in English, reply in English
- If customer writes in Marathi, reply in Marathi
- Match the customer's language naturally

YOUR PERSONALITY:
- Warm, friendly, enthusiastic about events
- Knowledgeable about all Phoenix Events services
- Helpful and patient
- Never pushy or salesy
- Use emojis naturally but not excessively

YOUR KNOWLEDGE BASE:
${kb}
${leadContext}

YOUR GOALS (in order):
1. Understand what event the customer is planning
2. Naturally collect: their name, event type, venue preference, guest count, event date
3. Share relevant information about Phoenix Events services and venues
4. Guide them towards scheduling a callback with our specialist
5. Make them feel excited and confident about choosing Phoenix Events

STRICT RULES — NEVER BREAK THESE:
- ONLY answer questions related to Phoenix Events & Production, events, venues, and services
- If asked about competitors, other companies, unrelated topics — politely redirect to Phoenix Events
- NEVER make up prices — always say a specialist will provide a customized quote
- NEVER hallucinate services or venues that are not in your knowledge base
- NEVER promise specific dates or availability — specialist will confirm
- If you don't know something, say "Main aapke liye specialist se confirm kar deti hoon"
- NEVER discuss politics, religion, or any topic unrelated to events

DATA COLLECTION — When you learn something new about the lead, add silent tags at the END of your message (user won't see these, they get stripped):
- When you learn their name: [LEAD:name=Rahul]
- When you learn event type: [LEAD:event_type=Wedding]
- When you learn venue: [LEAD:venue=Sky Blue Banquet Hall]
- When you learn guest count: [LEAD:guest_count=200]
- When you learn event date: [LEAD:event_date=15/12/2026]
- When lead is qualified (has name + event + date + guests): [LEAD:status=qualified][LEAD:score+5]
- When they show interest in venue: [LEAD:score+1]
- When they confirm event type: [LEAD:score+3]
- To send an event portfolio image: [SEND:image=event_wedding_image] or [SEND:image=event_birthday_image] etc.
- To send a venue image: [SEND:image=venue_1_image] through [SEND:image=venue_7_image]

CONVERSATION FLOW (natural, not scripted):
- Start by greeting warmly and asking how you can help
- As conversation flows, naturally collect lead data through conversation
- When they mention an event, express genuine excitement and share relevant services
- When discussing venues, mention our 7 partner venues with their highlights
- When they seem ready, suggest scheduling a callback: "Kya main aapke liye hamare specialist ka callback schedule kar doon? Woh 5 ghante mein call karenge aur aapko ek customized proposal denge!"
- Always end responses with either a question to keep conversation going or a clear next step

CALLBACK SCHEDULING:
If customer wants a callback, collect:
1. Preferred date (DD/MM/YYYY)
2. Preferred time slot
Then save: [LEAD:status=callback_scheduled]

Remember: You are having a REAL conversation. Be human. Be warm. Make them feel special.`;

  // Build conversation history for Claude
  var messages = [];

  // Add history
  history.forEach(function(h) {
    messages.push({
      role: h.direction === 'inbound' ? 'user' : 'assistant',
      content: h.content
    });
  });

  // Add current message
  messages.push({ role: 'user', content: userMessage });

  try {
    var response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: messages
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        }
      }
    );

    var fullText = response.data.content[0].text;
    console.log('Claude response (raw):', fullText.substring(0, 200));
    return fullText;

  } catch (err) {
    console.error('Claude API error:', JSON.stringify(err.response ? err.response.data : err.message));
    return 'Ek second, kuch technical issue aa gaya. Kripya thodi der baad try karein. 🙏';
  }
}

// ─────────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────────
async function handleMessage(phone, userMessage, name, msgId) {
  console.log('Handling message from:', phone, '| msg:', userMessage.substring(0, 50));

  // Log inbound
  await logInbound(phone, userMessage, msgId);

  // Get lead + history + knowledge base in parallel
  var [lead, history, knowledgeBase] = await Promise.all([
    getLead(phone),
    getConversationHistory(phone),
    getKnowledgeBase()
  ]);

  // Upsert lead (create if new, update interaction count if existing)
  await upsertLead(phone, name, {});

  // Call Claude
  var aiResponse = await callClaude(phone, userMessage, lead, history, knowledgeBase);

  // Extract any lead data tags from response
  var leadUpdates = extractLeadData(aiResponse, lead);
  var imageToSend = leadUpdates._sendImage;
  var scoreIncrement = leadUpdates._scoreIncrement;
  delete leadUpdates._sendImage;
  delete leadUpdates._scoreIncrement;

  // Clean tags from message
  var cleanResponse = cleanAiTags(aiResponse);

  // Send response to user
  await sendText(phone, cleanResponse);

  // Send image if AI requested one
  if (imageToSend) {
    try {
      var imgUrl = await getMediaImage(imageToSend);
      if (imgUrl) {
        await sleep(500);
        await sendImage(phone, imgUrl, '✨ Phoenix Events ka kaam!');
      }
    } catch (e) {}
  }

  // Save lead updates to Supabase
  if (Object.keys(leadUpdates).length > 0) {
    await upsertLead(phone, leadUpdates.name || name, leadUpdates);
    console.log('Lead updated with:', JSON.stringify(leadUpdates));
  }

  // Increment score if needed
  if (scoreIncrement) {
    await incrementLeadScore(phone, scoreIncrement);
  }
}

// ─────────────────────────────────────────────
// WEBHOOK ROUTES
// ─────────────────────────────────────────────
app.get('/whatsapp', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/whatsapp', async function(req, res) {
  try {
    var body = req.body;
    res.sendStatus(200); // Always respond immediately to Meta

    if (!body.object || body.object !== 'whatsapp_business_account') return;

    var entry = body.entry && body.entry[0];
    var changes = entry && entry.changes && entry.changes[0];
    var value = changes && changes.value;
    var messages = value && value.messages;

    if (!messages || !messages[0]) return;

    var msg = messages[0];

    // Only handle actual messages, not status updates
    if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') return;

    var msgId = msg.id;
    if (isDuplicate(msgId)) {
      console.log('Duplicate dropped:', msgId);
      return;
    }

    var phone = msg.from;
    var contacts = value.contacts || [];
    var name = (contacts[0] && contacts[0].profile && contacts[0].profile.name) || 'Friend';

    var messageText =
      (msg.text && msg.text.body) ||
      (msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.title) ||
      (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) ||
      (msg.button && msg.button.text) || '';

    if (!messageText.trim()) return;

    console.log('Incoming | Phone:', phone, '| Name:', name, '| Msg:', messageText);

    // Handle async — don't block Meta response
    handleMessage(phone, messageText, name, msgId).catch(function(e) {
      console.error('handleMessage error:', e.message);
    });

  } catch (e) {
    console.error('Webhook error:', e.message);
  }
});

app.get('/', function(req, res) {
  res.json({
    status: 'Phoenix WhatsApp AI Agent VERSION 2',
    timestamp: new Date().toISOString()
  });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Phoenix WhatsApp AI Agent VERSION 2 running on port ' + PORT);
});
