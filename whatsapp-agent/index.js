const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

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

// ── DEDUPLICATION ──
var processedMessages = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) return true;
  processedMessages.add(msgId);
  if (processedMessages.size > 1000) processedMessages.delete(processedMessages.values().next().value);
  return false;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function splitMessage(text) {
  if (!text || text.length <= 4000) return [text || ''];
  var chunks = []; var t = text;
  while (t.length > 0) { var c = t.substring(0, 4000); chunks.push(c.trim()); t = t.substring(c.length).trim(); }
  return chunks;
}

// ── WA SEND ──
async function sendText(phone, message) {
  try {
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    var chunks = splitMessage(message);
    for (var i = 0; i < chunks.length; i++) {
      await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
        { messaging_product: 'whatsapp', to: fp, type: 'text', text: { body: chunks[i] } },
        { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
      );
      if (chunks.length > 1) await sleep(600);
    }
    await logOutbound(phone, message);
  } catch (e) { console.error('sendText FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendImage(phone, imageUrl, caption) {
  try {
    if (!imageUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('sendImage FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

// ── SUPABASE ──
async function getLead(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { return null; }
}

async function upsertLead(phone, name, fields) {
  try {
    var existing = await getLead(phone);
    var now = new Date().toISOString();
    if (!existing) {
      var payload = Object.assign({
        phone: phone, name: name || 'Friend', status: 'new', step: 'ai_chat',
        source: fields && fields.source ? fields.source : 'whatsapp',
        first_channel: 'whatsapp', last_channel: 'whatsapp',
        whatsapp_count: 1, call_count: 0, lead_score: 0,
        last_interaction: now, created_at: now
      }, fields || {});
      await supabase.post('/rest/v1/leads', payload);
    } else {
      var update = Object.assign({
        last_interaction: now, last_channel: 'whatsapp',
        whatsapp_count: (existing.whatsapp_count || 0) + 1, updated_at: now
      }, fields || {});
      if (name && name !== 'Friend' && name !== 'Unknown' && !existing.name) update.name = name;
      if (existing.status === 'qualified' || existing.status === 'converted') delete update.status;
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, update);
    }
  } catch (e) { console.error('upsertLead:', e.message); }
}

async function incrementLeadScore(phone, amount) {
  try {
    var lead = await getLead(phone);
    if (lead) await supabase.patch('/rest/v1/leads?phone=eq.' + phone, { lead_score: (lead.lead_score || 0) + amount });
  } catch (e) {}
}

async function getConversationHistory(phone) {
  try {
    var res = await supabase.get('/rest/v1/conversations?lead_phone=eq.' + phone + '&channel=eq.whatsapp&order=created_at.desc&limit=20&select=direction,content,created_at');
    if (!res.data || res.data.length === 0) return [];
    return res.data.reverse();
  } catch (e) { return []; }
}

async function logInbound(phone, message, msgId) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'inbound', message_type: 'text',
      content: message, whatsapp_message_id: msgId || '', status: 'received', channel: 'whatsapp'
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
  } catch (e) { return []; }
}

async function getMediaImage(key) {
  try {
    var res = await supabase.get('/rest/v1/workflow_content?content_key=eq.' + key + '&is_active=eq.true&select=media_assets(public_url)');
    if (res.data && res.data[0] && res.data[0].media_assets) return res.data[0].media_assets.public_url;
    return null;
  } catch (e) { return null; }
}

function buildKnowledgeContext(kb) {
  if (!kb || kb.length === 0) return '';
  var grouped = {};
  kb.forEach(function(item) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push('## ' + item.title + '\n' + item.content);
  });
  return Object.keys(grouped).map(function(cat) {
    return '### ' + cat.toUpperCase() + '\n' + grouped[cat].join('\n\n');
  }).join('\n\n');
}

// ── EXTRACT LEAD DATA FROM AI RESPONSE ──
function extractLeadData(aiText) {
  var updates = {};
  var patterns = {
    name: /\[LEAD:name=([^\]]+)\]/,
    event_type: /\[LEAD:event_type=([^\]]+)\]/,
    venue: /\[LEAD:venue=([^\]]+)\]/,
    guest_count: /\[LEAD:guest_count=([^\]]+)\]/,
    event_date: /\[LEAD:event_date=([^\]]+)\]/,
    status: /\[LEAD:status=([^\]]+)\]/,
    package_type: /\[LEAD:package_type=([^\]]+)\]/,
    services_needed: /\[LEAD:services=([^\]]+)\]/,
    theme: /\[LEAD:theme=([^\]]+)\]/,
    indoor_outdoor: /\[LEAD:indoor_outdoor=([^\]]+)\]/,
    email: /\[LEAD:email=([^\]]+)\]/,
    city: /\[LEAD:city=([^\]]+)\]/,
    source: /\[LEAD:source=([^\]]+)\]/,
    function_list: /\[LEAD:functions=([^\]]+)\]/,
    relationship_to_event: /\[LEAD:relationship=([^\]]+)\]/,
    preferred_call_time: /\[LEAD:call_time=([^\]]+)\]/,
    instagram_id: /\[LEAD:instagram=([^\]]+)\]/
  };
  for (var key in patterns) {
    var m = aiText.match(patterns[key]);
    if (m) {
      if (key === 'guest_count') { var n = parseInt(m[1]); if (!isNaN(n)) updates.guest_count = n; }
      else updates[key] = m[1].trim();
    }
  }
  var scoreMatch = aiText.match(/\[LEAD:score\+(\d+)\]/);
  if (scoreMatch) updates._scoreIncrement = parseInt(scoreMatch[1]);
  var imgMatch = aiText.match(/\[SEND:image=([^\]]+)\]/g);
  if (imgMatch) updates._sendImages = imgMatch.map(function(t) { return t.replace('[SEND:image=', '').replace(']', ''); });
  return updates;
}

function cleanAiTags(text) {
  return text.replace(/\[LEAD:[^\]]+\]/g, '').replace(/\[SEND:[^\]]+\]/g, '').trim();
}

// ── DETECT LANGUAGE FROM MESSAGE ──
function detectLanguage(text) {
  if (!text) return 'hinglish';
  var marathiChars = (text.match(/[\u0900-\u097F]/g) || []).length;
  if (marathiChars > 3) return 'marathi_devanagari';
  var hindiWords = ['kya', 'hai', 'hoon', 'aap', 'main', 'mera', 'meri', 'nahi', 'bahut', 'acha', 'karo', 'karo', 'chahiye', 'plan', 'kar', 'raha', 'rahi'];
  var englishWords = ['the', 'is', 'are', 'what', 'how', 'when', 'where', 'want', 'need', 'have', 'plan', 'event'];
  var lc = text.toLowerCase();
  var hindiCount = hindiWords.filter(function(w) { return lc.indexOf(w) !== -1; }).length;
  var engCount = englishWords.filter(function(w) { return lc.indexOf(w) !== -1; }).length;
  if (engCount > hindiCount + 2) return 'english';
  return 'hinglish';
}

// ── CALL GROQ AI ──
async function callGroq(phone, userMessage, lead, history, knowledgeBase) {
  var kb = buildKnowledgeContext(knowledgeBase);
  var lang = detectLanguage(userMessage);

  var leadContext = '';
  if (lead) {
    var hasName = lead.name && lead.name !== 'Friend' && lead.name !== 'Guest' && lead.name !== 'Unknown';
    var hasEvent = lead.event_type && lead.event_type !== 'Unknown';
    var alreadyKnow = [];
    if (hasName) alreadyKnow.push('naam: ' + lead.name);
    if (hasEvent) alreadyKnow.push('event: ' + lead.event_type);
    if (lead.venue) alreadyKnow.push('venue: ' + lead.venue);
    if (lead.guest_count) alreadyKnow.push('guests: ' + lead.guest_count);
    if (lead.event_date) alreadyKnow.push('date: ' + lead.event_date);
    if (lead.package_type) alreadyKnow.push('package: ' + lead.package_type);
    if (lead.services_needed) alreadyKnow.push('services: ' + lead.services_needed);
    if (lead.email) alreadyKnow.push('email: ' + lead.email);
    if (lead.preferred_call_time) alreadyKnow.push('call_time: ' + lead.preferred_call_time);

    leadContext = 'RETURNING CUSTOMER — naam se warmly greet karo.\n\n' +
      'Pehle se pata hai: ' + (alreadyKnow.length ? alreadyKnow.join(', ') : 'kuch nahi') + '\n' +
      'Calls: ' + (lead.call_count || 0) + ' | WA messages: ' + (lead.whatsapp_count || 0) + '\n' +
      'Voice call hua: ' + (lead.call_count > 0 ? 'haan — voice agent ne major questions pooche hain' : 'nahi — WP agent pehli baar baat kar raha hai') + '\n\n' +
      'JO PEHLE SE PATA HAI WOH MAT POOCHO — sirf jo missing hai woh collect karo.\n' +
      'Missing fields: ' +
      (!hasName ? 'naam, ' : '') +
      (!hasEvent ? 'event type, ' : '') +
      (!lead.guest_count ? 'guest count, ' : '') +
      (!lead.event_date ? 'event date, ' : '') +
      (!lead.venue ? 'venue preference, ' : '') +
      (!lead.package_type ? 'package type, ' : '') +
      (!lead.services_needed ? 'services needed, ' : '') +
      (!lead.email ? 'email, ' : '') +
      'aur baaki kuch jo user ne nahi bataya';
  } else {
    leadContext = 'NEW CUSTOMER — pehli baar baat ho rahi hai.\nSabhi major questions poochne hain — naam, event, date, guests, venue, package, services.';
  }

  var langInstruction = '';
  if (lang === 'english') {
    langInstruction = 'User English mein likh raha hai — English mein reply karo. Warm aur friendly English use karo.';
  } else if (lang === 'marathi_devanagari') {
    langInstruction = 'User Marathi (Devanagari script) mein likh raha hai — Marathi mein reply karo. Devanagari script use karo Marathi ke liye.';
  } else {
    langInstruction = 'User Hinglish mein likh raha hai — Hinglish mein reply karo (Hindi words, Roman script). Jaise: "kya plan kar rahe ho", "kitne log aa rahe hain". Pure Hindi mat likho, pure English mat likho.';
  }

  var systemPrompt = 'Tu Aishwarya hai — Phoenix Events & Production ki WhatsApp assistant, Pimpri-Chinchwad, Pune se.\n\n' +
    'Tu ek warm, soft-spoken, polite aur friendly Maharashtrian ladki hai. Real insaan ki tarah baat kar — kabhi robotic mat lag.\n\n' +

    'LANGUAGE:\n' + langInstruction + '\n' +
    'HAMESHA female words use kar: bataungi, karungi, bhejungi, hoon, rahi hoon — kabhi bataunga/karunga mat likhna.\n\n' +

    'GENDER DETECT: Naam se gender samajhne ki koshish kar aur accordingly baat kar.\n\n' +

    'RESPONSE STYLE:\n' +
    '- 2-3 lines max — na zyada lamba, na sirf ek liner\n' +
    '- Ek hi sawaal ek response mein\n' +
    '- *bold* important cheezein — venue names, dates, amounts\n' +
    '- Emojis natural jagah use kar\n' +
    '- Short, warm, conversational — paragraph mat likho\n\n' +

    'CUSTOMER STATUS:\n' + leadContext + '\n\n' +

    'KNOWLEDGE BASE:\n' + kb + '\n\n' +

    'COMPANY INFO:\n' +
    'Phoenix Events & Production | Pimpri-Chinchwad, Pune\n' +
    'Website: phoenixeventsandproduction.com\n' +
    'Instagram: @phoenix_events_and_production\n' +
    'Call: +91 80357 35856\n\n' +

    'PARTNER VENUES (7):\n' +
    '1. Sky Blue Banquet Hall — Punawale/Ravet ⭐4.7 | 100-500 guests\n' +
    '2. Blue Water Banquet Hall — Punawale ⭐5.0 | 50-300 guests\n' +
    '3. Thopate Banquets — Rahatani | 100-400 guests\n' +
    '4. RamKrishna Veg Banquet — Ravet ⭐4.4 | 50-250 guests (veg only)\n' +
    '5. Shree Krishna Palace — Pimpri Colony ⭐4.3 | 100-600 guests\n' +
    '6. Raghunandan AC Banquet — Tathawade ⭐4.0 | 100-350 guests\n' +
    '7. Rangoli Banquet Hall — Chinchwad ⭐4.3 | 100-500 guests\n\n' +

    'CONVERSATION FLOW (jo already pata hai woh SKIP karo):\n' +
    '1. Greet (returning = naam se, new = fresh greeting)\n' +
    '2. Naam (agar nahi pata)\n' +
    '3. Event type (agar nahi pata) → turant related portfolio image bhejo\n' +
    '4. Relationship to event (smartly based on event type)\n' +
    '5. Event date (agar nahi pata)\n' +
    '6. Guest count (agar nahi pata)\n' +
    '7. Venue (agar nahi pata) → suggest hamara venues, images bhejo\n' +
    '8. Services — pehle services batao, phir poocho konsi chahiye\n' +
    '9. Package type (smart question — simple/standard/premium/luxury)\n' +
    '10. Theme/vibe preference\n' +
    '11. Indoor/Outdoor\n' +
    '12. Associated functions (wedding=mehendi/haldi/sangeet, birthday=dj/return gifts)\n' +
    '13. Preferred call time\n' +
    '14. Email ID\n' +
    '15. Summary offer + specialist CTA\n\n' +

    'SERVICES BY EVENT:\n' +
    'Wedding: Stage & Mandap Decoration, Floral Decoration, Lighting & LED, Photography, Videography, DJ & Sound, Entry Gate Setup, Photo Booth, Return Gift Coordination, Full Planning\n' +
    'Birthday: Theme Setup, Balloon & Floral Decoration, Cake Table, Photo Booth, DJ & Sound, Return Gifts, Entry Decoration\n' +
    'Corporate: Stage & Backdrop, Branding & Signage, AV Setup, Lighting, Full Event Management\n\n' +

    'SMART BUDGET QUESTION (kabhi direct price mat poocho):\n' +
    '"Aap kaisa event imagine kar rahe ho — simple aur elegant, standard, premium ya full luxury?"\n' +
    'Map internally: simple=low, standard=medium, premium=high, luxury=very high\n' +
    'Pricing negotiations → ALWAYS specialist ke paas bhejo\n\n' +

    'CATERING:\n' +
    '"Catering abhi hum directly provide nahi karte, lekin hamare specialist aapke liye best option dhundhenge!"\n\n' +

    'IMAGES — CRITICAL:\n' +
    '- Tu photos bhej sakti hai — [SEND:image=key] tag use kar\n' +
    '- Kabhi mat bolo "main photos nahi bhej sakti"\n' +
    '- Event images: [SEND:image=event_wedding_image], [SEND:image=event_birthday_image], etc.\n' +
    '- Venue images: [SEND:image=venue_1_image] through [SEND:image=venue_7_image]\n' +
    '- Jab bhi event ya venue discuss ho → relevant image bhejo\n\n' +

    'HANDOFF FROM VOICE (agar lead ka call_count > 0 hai):\n' +
    'Voice agent ne pehle se major data collect kiya hai. WP agent ka role:\n' +
    '- Warmly welcome karo — "Voice pe baat ho gayi, main Aishwarya WhatsApp pe bhi hoon!"\n' +
    '- Remaining/missing questions poocho\n' +
    '- Photos aur media share karo\n' +
    '- Summary bhejo\n\n' +

    'STRICT RULES:\n' +
    '- Sirf Phoenix Events related topics pe baat karo\n' +
    '- Off-topic: "Main sirf Phoenix Events ke baare mein help kar sakti hoon 😊"\n' +
    '- Disrespect (bad language/rude): "Yeh conversation record ho rahi hai. Kripya respectfully baat karein."\n' +
    '- Agar continues: "Is conversation ko yahan rok rahi hoon. Phoenix Events ke liye dobara message kar sakte hain."\n' +
    '- Price kabhi mat batao — specialist ko bhejo\n\n' +

    'DETAILS CONFIRMATION (jab naam+event+date ya guests pata ho):\n' +
    'Ek baar summary offer karo: "Kya aap chahenge ki main ek chhoti summary bhejun — kya save hua hai?"\n' +
    'Agar yes:\n' +
    '"✅ *Aapki saved details:*\n[relevant fields only]\n\nKuch change karna ho toh bas batao! 😊"\n' +
    'Phir: "Hamare specialist *aaj hi* call karenge! 🙏\n📞 *+91 80357 35856*\n🌐 phoenixeventsandproduction.com"\n\n' +

    'DATA COLLECTION TAGS (message ke BILKUL END mein — user ko nahi dikhte):\n' +
    '[LEAD:name=Rahul] [LEAD:event_type=Wedding] [LEAD:venue=Sky Blue Banquet Hall]\n' +
    '[LEAD:guest_count=200] [LEAD:event_date=15/06/2026] [LEAD:package_type=premium]\n' +
    '[LEAD:services=decoration,photography] [LEAD:theme=Royal] [LEAD:indoor_outdoor=indoor]\n' +
    '[LEAD:email=rahul@gmail.com] [LEAD:city=Pimpri-Chinchwad] [LEAD:source=instagram]\n' +
    '[LEAD:functions=mehendi,sangeet,haldi] [LEAD:relationship=self]\n' +
    '[LEAD:call_time=evening] [LEAD:instagram=@rahul_ig]\n' +
    '[LEAD:status=qualified] [LEAD:score+5] [LEAD:score+3] [LEAD:score+1]\n\n' +
    'CALLBACK SCHEDULING:\n' +
    '"Kya main specialist ka callback schedule kar doon? 😊 Woh *aaj hi* call karenge!\n' +
    'Kaunsa time suit karega — morning, afternoon ya evening?"\n' +
    'Date+time collect karo → [LEAD:status=callback_scheduled] [LEAD:call_time=evening]';

  var messages = [];
  history.forEach(function(h) {
    messages.push({ role: h.direction === 'inbound' ? 'user' : 'assistant', content: h.content });
  });
  messages.push({ role: 'user', content: userMessage });

  try {
    var response = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', max_tokens: 600, temperature: 0.6, messages: [{ role: 'system', content: systemPrompt }].concat(messages) },
      { headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' } }
    );
    var fullText = response.data.choices[0].message.content;
    console.log('Groq response:', fullText.substring(0, 150));
    return fullText;
  } catch (err) {
    console.error('Groq error:', JSON.stringify(err.response ? err.response.data : err.message));
    return 'Ek second, thodi technical dikkat aa gayi. Kripya dobara try karein ya humein call karein: +91 80357 35856 🙏';
  }
}

// ── MAIN MESSAGE HANDLER ──
async function handleMessage(phone, userMessage, name, msgId) {
  console.log('Message from:', phone, '| text:', userMessage.substring(0, 60));
  await logInbound(phone, userMessage, msgId);

  var [lead, history, knowledgeBase] = await Promise.all([getLead(phone), getConversationHistory(phone), getKnowledgeBase()]);
  await upsertLead(phone, name, {});

  var aiResponse = await callGroq(phone, userMessage, lead, history, knowledgeBase);
  var extracted = extractLeadData(aiResponse);
  var imagesToSend = extracted._sendImages || [];
  var scoreIncrement = extracted._scoreIncrement || 0;
  delete extracted._sendImages;
  delete extracted._scoreIncrement;

  var cleanResponse = cleanAiTags(aiResponse);
  await sendText(phone, cleanResponse);

  // Send images
  for (var i = 0; i < imagesToSend.length; i++) {
    try {
      var imgUrl = await getMediaImage(imagesToSend[i]);
      if (imgUrl) { await sleep(600); await sendImage(phone, imgUrl, '✨ Phoenix Events'); }
    } catch (e) {}
  }

  // Map venue field
  if (extracted.venue) { extracted.venue_name = extracted.venue; delete extracted.venue; }

  // Update urgency
  if (extracted.event_date) {
    try {
      var parts = extracted.event_date.split('/');
      if (parts.length === 3) {
        var days = Math.floor((new Date(parts[2], parts[1] - 1, parts[0]) - new Date()) / 86400000);
        extracted.urgency_level = days <= 30 ? 'high' : days <= 90 ? 'medium' : 'low';
      }
    } catch (e) {}
  }

  if (Object.keys(extracted).length > 0) {
    await upsertLead(phone, extracted.name || name, extracted);
  }
  if (scoreIncrement) await incrementLeadScore(phone, scoreIncrement);
}

// ── WEBHOOK ROUTES ──
app.get('/whatsapp', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('Webhook verified'); res.status(200).send(challenge); }
  else res.sendStatus(403);
});

app.post('/whatsapp', async function(req, res) {
  try {
    var body = req.body;
    res.sendStatus(200);
    if (!body.object || body.object !== 'whatsapp_business_account') return;
    var entry = body.entry && body.entry[0];
    var changes = entry && entry.changes && entry.changes[0];
    var value = changes && changes.value;
    var messages = value && value.messages;
    if (!messages || !messages[0]) return;
    var msg = messages[0];
    if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') return;
    var msgId = msg.id;
    if (isDuplicate(msgId)) { console.log('Duplicate dropped:', msgId); return; }
    var phone = msg.from;
    var contacts = value.contacts || [];
    var name = (contacts[0] && contacts[0].profile && contacts[0].profile.name) || 'Friend';
    var messageText =
      (msg.text && msg.text.body) ||
      (msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.title) ||
      (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) ||
      (msg.button && msg.button.text) || '';
    if (!messageText.trim()) return;
    console.log('Incoming | Phone:', phone, '| Name:', name, '| Msg:', messageText.substring(0, 60));
    handleMessage(phone, messageText, name, msgId).catch(function(e) { console.error('handleMessage error:', e.message); });
  } catch (e) { console.error('Webhook error:', e.message); }
});

app.get('/', function(req, res) {
  res.json({ status: 'Phoenix WhatsApp AI Agent VERSION 3', timestamp: new Date().toISOString() });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Phoenix WhatsApp AI Agent VERSION 3 running on port ' + PORT); });
