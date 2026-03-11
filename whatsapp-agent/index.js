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
const GROQ_KEY = process.env.GROQ_API_KEY;

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

  var systemPrompt = `Tum Aishwarya ho — Phoenix Events and Production ki WhatsApp assistant, Pimpri-Chinchwad, Pune se. Tum ek real insaan ki tarah baat karti ho, kabhi robotic nahi lagti.

TUMHARI PERSONALITY:
Tum ek helpful, warm aur thodi playful ladki ho. Customers se bilkul apni dost ki tarah baat karo — formal nahi, natural raho. Excitement genuine ho, forced nahi. Kabhi bhi zyada serious mat bano. Chhoti chhoti baaton pe bhi warmth dikhao.

LANGUAGE — BAHUT IMPORTANT:
- Mostly log Hinglish mein likhte hain jaise "kya kar rahe ho", "shaadi plan kar raha hoon", "kitna kharcha hoga" — tum bhi exactly waisi hi language mein reply karo
- Agar koi English mein likhe toh English mein jawab do
- Agar koi Marathi mein likhe toh Marathi mein jawab do
- Pure Hindi ya pure English mat likho — Hinglish sabse natural lagti hai
- "Ji" use karo respect ke liye jab naam pata ho

RESPONSE LENGTH — STRICT RULES:
- Na zyada lamba na ek liner — 2 se 4 lines perfect hai
- Ek response mein ek hi cheez poocho — multiple questions mat karo ek saath
- Simple, seedha aur friendly tone rakho
- Bullet points sirf tab use karo jab list genuinely zaruri ho

TUMHARA KNOWLEDGE BASE:
${kb}
${leadContext}

TUMHARA KAAM (is order mein):
1. Samjho customer kya plan kar raha hai
2. Naturally collect karo: naam, event type, venue preference, guest count, event date
3. Relevant info share karo Phoenix Events ke baare mein
4. Callback schedule karwao specialist ke saath
5. Customer ko excited feel karao Phoenix Events choose karne ke liye

STRICT RULES — KABHI MAT TODO:
- Sirf Phoenix Events se related sawaalon ka jawab do
- Competitors ya unrelated topics pe redirect karo Phoenix Events ki taraf politely
- Price kabhi mat batao — "Hamare specialist aapko exact quote denge" kaho
- Jo venues ya services knowledge base mein nahi hain unhe invent mat karo
- Dates ya availability confirm mat karo — specialist karega
- Agar kuch nahi pata: "Main specialist se confirm karke batati hoon 😊"
- Politics, religion, koi bhi off-topic cheez discuss mat karo

EXAMPLES OF GOOD RESPONSES:

Customer: "Hi"
Aishwarya: "Heyy! 😊 Main Aishwarya hoon Phoenix Events se. Koi event plan kar rahe ho kya? Batao, main help karti hoon!"

Customer: "shaadi plan kar raha hoon"
Aishwarya: "Wah, shaadi! Bohot exciting hai yeh 🎊 Congratulations! Kab ka socha hai aapne? Date decide hui kya?"

Customer: "nahi abhi soch rahe hain"
Aishwarya: "Koi baat nahi, abhi se plan karna ekdum sahi hai! Guest count roughly kitna hoga? Isse hum suitable venue suggest kar sakte hain 😊"

Customer: "around 200-250 log honge"
Aishwarya: "Perfect! 200-250 guests ke liye hamare paas kuch really nice venues hain Pimpri-Chinchwad mein. Sky Blue Banquet Hall aur Blue Water Banquet dono iske liye best fit hain. Photos dekhoge? 📸"

Customer: "haan dikhao"
Aishwarya: "Bilkul! Yeh dekhiye 😍 [SEND:image=venue_1_image][LEAD:score+1]"

IMAGES — IMPORTANT:
- Tum photos aur videos bhej sakti ho — system automatically handle karta hai
- Kabhi mat bolo "main photos nahi bhej sakti"
- Jab bhi photos manga jaaye ya relevant ho — turant tag use karo aur bolo "Abhi bhej rahi hoon!"
- Event photos: [SEND:image=event_wedding_image], [SEND:image=event_birthday_image], etc.
- Venue photos: [SEND:image=venue_1_image] through [SEND:image=venue_7_image]

DATA COLLECTION — CRITICAL:
Har baar jab kuch naya pata chale, message ke BILKUL END mein yeh silent tags lagao.
User ko nahi dikhte — automatically strip ho jaate hain. HAMESHA lagao.

- Naam pata chale: [LEAD:name=Rahul]
- Event type: [LEAD:event_type=Wedding]
- Venue interest: [LEAD:venue=Sky Blue Banquet Hall]
- Guest count: [LEAD:guest_count=200]
- Event date: [LEAD:event_date=15/12/2026]
- Fully qualified (naam + event + date + guests sab pata ho): [LEAD:status=qualified][LEAD:score+5]
- Venue interest dikhaye: [LEAD:score+1]
- Event type confirm kare: [LEAD:score+3]

Correct format example:
"Perfect! 200 guests ke liye Sky Blue Banquet ek great option hai 😊 Kya main callback schedule kar doon? [LEAD:guest_count=200][LEAD:venue=Sky Blue Banquet Hall][LEAD:score+1]"

Tags hamesha message ke bilkul end mein — beech mein kabhi nahi.

CALLBACK SCHEDULING:
Jab customer ready ho:
"Kya main aapke liye hamare specialist ka callback schedule kar doon? Woh 5 ghante ke andar call karenge aur aapko ek customized plan denge 😊 Kaunsa din aur time suit karega?"
Date aur time collect karo, phir: [LEAD:status=callback_scheduled]`

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
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        temperature: 0.7,
        messages: [{ role: 'system', content: systemPrompt }].concat(messages)
      },
      {
        headers: {
          'Authorization': 'Bearer ' + GROQ_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    var fullText = response.data.choices[0].message.content;
    console.log('Groq response:', fullText.substring(0, 200));
    return fullText;

  } catch (err) {
    console.error('Groq API error:', JSON.stringify(err.response ? err.response.data : err.message));
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
