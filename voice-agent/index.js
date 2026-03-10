const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = 'https://fhhwfqlbgmsscmqihjyz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZoaHdmcWxiZ21zc2NtcWloanl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MzgwNTksImV4cCI6MjA4NzAxNDA1OX0.T1n19S4_D7eNX4bz9AovBXwKrwOjGxvrzFGpO4nNxJ4';
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = '1023140200877702';

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
// WHATSAPP HELPERS
// ─────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  try {
    var fullPhone = phone.startsWith('+') ? phone : '+' + phone;
    var resp = await axios.post(
      'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fullPhone, type: 'text', text: { body: message } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN } }
    );
    console.log('WA sent to ' + fullPhone + ' | ' + JSON.stringify(resp.data));
  } catch (err) {
    console.error('WA FAILED:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function sendWhatsAppImage(phone, imageUrl, caption) {
  try {
    var fullPhone = phone.startsWith('+') ? phone : '+' + phone;
    var resp = await axios.post(
      'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fullPhone, type: 'image', image: { link: imageUrl, caption: caption } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN } }
    );
    console.log('WA image sent to ' + fullPhone + ' | ' + JSON.stringify(resp.data));
  } catch (err) {
    console.error('WA image FAILED:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

// ─────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────
async function getLeadByPhone(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) {
    console.error('getLeadByPhone error:', e.message);
    return null;
  }
}

async function getEventImage(eventType) {
  try {
    var key = 'event_' + eventType.toLowerCase().replace(/\s+/g, '_') + '_image';
    console.log('Looking up image key:', key);

    var res = await supabase.get(
      '/rest/v1/workflow_content?content_key=eq.' + key +
      '&is_active=eq.true&select=text_content,media_asset_id,media_assets(public_url)'
    );
    if (res.data && res.data[0]) {
      var row = res.data[0];
      if (row.media_assets && row.media_assets.public_url) return row.media_assets.public_url;
      if (row.text_content) return row.text_content;
    }

    var fallback = await supabase.get(
      '/rest/v1/media_assets?subcategory=eq.' + eventType.toLowerCase() +
      '&is_active=eq.true&file_type=eq.image&select=public_url&order=sort_order.asc&limit=1'
    );
    if (fallback.data && fallback.data[0]) return fallback.data[0].public_url;

    return null;
  } catch (e) {
    console.error('getEventImage error:', e.message);
    return null;
  }
}

async function saveVoiceCall(data) {
  try {
    await supabase.post('/rest/v1/voice_calls', {
      phone: data.phone,
      name: data.name,
      call_type: 'inbound',
      call_status: 'completed',
      gathered_event_type: data.event_type,
      gathered_venue: data.venue_name,
      gathered_guest_count: parseGuestCount(data.guest_count),
      gathered_event_date: data.event_date || null,
      whatsapp_sent: false,
      duration_seconds: data.duration_seconds || 0,
      call_outcome: data.event_type ? 'data_collected' : 'no_data'
    });
    console.log('Voice call saved for', data.phone, '| duration:', data.duration_seconds || 0, 's');
  } catch (err) {
    console.error('Supabase save error:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function logConversation(phone, content, direction) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone,
      direction: direction || 'outbound',
      message_type: 'voice',
      content: content,
      status: 'completed',
      channel: 'voice'
    });
  } catch (e) {}
}

async function upsertLead(data) {
  try {
    var existing = await supabase.get('/rest/v1/leads?phone=eq.' + data.phone + '&select=id,call_count,call_duration_seconds,first_channel');
    var isNew = !existing.data || existing.data.length === 0;
    var existingRecord = isNew ? null : existing.data[0];

    var callCount = isNew ? 1 : ((existingRecord.call_count || 0) + 1);
    var totalDuration = isNew
      ? (data.duration_seconds || 0)
      : ((existingRecord.call_duration_seconds || 0) + (data.duration_seconds || 0));

    var payload = {
      phone: data.phone,
      updated_at: new Date().toISOString(),
      last_interaction: new Date().toISOString(),
      last_channel: 'voice',
      voice_qualified: true,
      last_call_at: new Date().toISOString(),
      call_count: callCount,
      call_duration_seconds: totalDuration
    };

    if (data.name && data.name !== 'Guest') payload.name = data.name;
    if (data.event_type) payload.event_type = data.event_type;
    if (data.venue_name) payload.venue = data.venue_name;
    if (data.guest_count) payload.guest_count = parseGuestCount(data.guest_count);
    if (data.event_date) payload.event_date = data.event_date;

    if (isNew) {
      payload.source = 'voice_call';
      payload.status = 'new';
      payload.first_channel = 'voice';
      payload.whatsapp_count = 0;
      await supabase.post('/rest/v1/leads', payload);
      console.log('New lead created for', data.phone);
    } else {
      if (!existingRecord.first_channel) payload.first_channel = 'voice';
      await supabase.patch('/rest/v1/leads?phone=eq.' + data.phone, payload);
      console.log('Lead updated for', data.phone, '| call_count:', callCount, '| total_duration:', totalDuration + 's');
    }
  } catch (err) {
    console.error('upsertLead error:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function markWhatsAppSent(phone) {
  try {
    await supabase.patch(
      '/rest/v1/voice_calls?phone=eq.' + phone + '&whatsapp_sent=eq.false',
      { whatsapp_sent: true, updated_at: new Date().toISOString() }
    );
  } catch (e) {}
}

// ─────────────────────────────────────────────
// PARSE GUEST COUNT
// ─────────────────────────────────────────────
function parseGuestCount(val) {
  if (!val) return null;
  var s = String(val).toLowerCase().trim();

  var hindiMap = {
    'एक सौ': 100, 'दो सौ': 200, 'तीन सौ': 300, 'चार सौ': 400,
    'पांच सौ': 500, 'छह सौ': 600, 'सात सौ': 700, 'आठ सौ': 800,
    'नौ सौ': 900, 'पचास': 50, 'सौ': 100, 'दो सौ पचास': 250,
    'तीन सौ पचास': 350, 'डेढ़ सौ': 150
  };
  for (var k in hindiMap) {
    if (s.indexOf(k) !== -1) return hindiMap[k];
  }

  var engMap = {
    'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
    'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
    'one hundred': 100, 'two hundred': 200, 'three hundred': 300,
    'four hundred': 400, 'five hundred': 500, 'six hundred': 600,
    'seven hundred': 700, 'eight hundred': 800, 'nine hundred': 900,
    'hundred': 100, 'thousand': 1000
  };
  for (var ek in engMap) {
    if (s.indexOf(ek) !== -1) return engMap[ek];
  }

  var n = parseInt(s.replace(/[^0-9]/g, ''));
  return isNaN(n) ? null : n;
}

// ─────────────────────────────────────────────
// SANITIZE VALUES — strip Bolna "NULL" strings
// ─────────────────────────────────────────────
function cleanVal(val) {
  if (!val) return '';
  var s = String(val).trim();
  if (s.toUpperCase() === 'NULL' || s === '{}' || s === 'undefined') return '';
  return s;
}

// ─────────────────────────────────────────────
// EXTRACT FROM TRANSCRIPT
// ─────────────────────────────────────────────
function extractFromTranscript(transcript) {
  var data = { name: '', event_type: '', venue_booked: false, venue_name: '', guest_count: '', event_date: '' };
  if (!transcript) return data;

  var nameMatch = transcript.match(/मेरा नाम ([^\n,।]+)/i) ||
                  transcript.match(/my name is ([^\n,।]+)/i) ||
                  transcript.match(/naam hai ([^\n,।]+)/i);
  if (nameMatch) data.name = nameMatch[1].trim().split(' ')[0];

  var events = ['wedding', 'birthday', 'engagement', 'sangeet', 'haldi', 'mehendi', 'anniversary', 'corporate', 'reception', 'शादी', 'जन्मदिन', 'सगाई'];
  for (var i = 0; i < events.length; i++) {
    if (transcript.toLowerCase().indexOf(events[i].toLowerCase()) !== -1) {
      data.event_type = events[i].charAt(0).toUpperCase() + events[i].slice(1);
      break;
    }
  }

  var guestMatch = transcript.match(/(\d+)\s*guest/i) || transcript.match(/(\d+)\s*मेहमान/i);
  if (guestMatch) data.guest_count = guestMatch[1];

  return data;
}

// ─────────────────────────────────────────────
// PARSE DURATION from Bolna payload
// ─────────────────────────────────────────────
function parseDuration(body) {
  var d = body.call_duration ||
          body.duration ||
          body.call_length ||
          (body.metadata && body.metadata.call_duration) ||
          (body.metadata && body.metadata.duration) || 0;
  var n = parseInt(d);
  return isNaN(n) ? 0 : n;
}

// ─────────────────────────────────────────────
// MAIN WHATSAPP FLOW
// ─────────────────────────────────────────────
async function handleWhatsAppFlow(data) {
  console.log('Starting WA flow:', JSON.stringify(data));

  // Step 1: DB
  try { await saveVoiceCall(data); } catch(e) { console.error('saveVoiceCall failed:', e.message); }
  try { await upsertLead(data); } catch(e) { console.error('upsertLead failed:', e.message); }

  // Log call as conversation entry for dashboard timeline
  try {
    await logConversation(
      data.phone,
      'Voice call completed | Event: ' + (data.event_type || 'N/A') +
      ' | Duration: ' + (data.duration_seconds || 0) + 's',
      'inbound'
    );
  } catch(e) {}

  // Step 2: Message 1 — venue booked or venue list
  if (data.venue_booked === true || data.venue_booked === 'true') {
    await sendWhatsApp(data.phone,
      '🎉 ' + data.name + ' ji, Phoenix Events mein aapka swagat hai!\n\n' +
      '🎊 Event: ' + (data.event_type || 'TBD') + '\n' +
      '🏛️ Venue: ' + (data.venue_name || 'Aapka selected venue') + '\n' +
      '👥 Guests: ' + (data.guest_count || 'TBD') + '\n' +
      '📅 Date: ' + (data.event_date || 'TBD') + '\n\n' +
      'Hamara specialist 5 ghante mein aapko call karega! 🙏\n\n' +
      '🌐 phoenixeventsandproduction.com');
  } else {
    await sendWhatsApp(data.phone,
      '🏛️ ' + data.name + ' ji, Phoenix Events ke saath baat karke achha laga! 😊\n\n' +
      'Hamare 7 premium partner venues Pimpri-Chinchwad mein:\n\n' +
      '1️⃣ Sky Blue Banquet Hall — Ravet ⭐4.7\n' +
      '2️⃣ Thopate Banquets — Rahatani\n' +
      '3️⃣ Blue Water Banquet Hall — Punawale ⭐5.0\n' +
      '4️⃣ RamKrishna Veg Banquet — Ravet ⭐4.4\n' +
      '5️⃣ Shree Krishna Palace — Pimpri Colony ⭐4.3\n' +
      '6️⃣ Raghunandan AC Banquet — Tathawade ⭐4.0\n' +
      '7️⃣ Rangoli Banquet Hall — Chinchwad ⭐4.3\n\n' +
      'Koi bhi venue pasand aaye toh hume batao! 🎊\n\n' +
      '🌐 phoenixeventsandproduction.com');
  }

  // Step 3: Event image from dashboard
  try {
    if (data.event_type) {
      var imageUrl = await getEventImage(data.event_type);
      if (imageUrl) {
        await sendWhatsAppImage(data.phone, imageUrl,
          '✨ ' + data.event_type + ' ke liye hamare kaam ki jhalak!');
      } else {
        console.log('No image configured for:', data.event_type);
      }
    }
  } catch(e) { console.error('Image step failed:', e.message); }

  // Step 4: Summary message
  await sendWhatsApp(data.phone,
    '📋 Aapki details humne note kar li hain:\n\n' +
    '🎊 Event: ' + (data.event_type || 'TBD') + '\n' +
    '👥 Guests: ' + (data.guest_count || 'TBD') + '\n' +
    '📅 Date: ' + (data.event_date || 'TBD') + '\n\n' +
    'Hamara specialist 5 ghante mein aapko call karega! 🎉\n\n' +
    'Koi sawaal ho toh yahan message kar sakte hain.\n' +
    '🌐 phoenixeventsandproduction.com');

  try { await markWhatsAppSent(data.phone); } catch(e) {}
  console.log('WA flow complete for', data.phone);
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({ status: 'Phoenix Events Webhook VERSION 6', timestamp: new Date().toISOString() });
});

app.post('/phoenix-bolna-agent', async function(req, res) {
  console.log('=== NEW REQUEST ===');
  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  var status = body && body.status;
  var userNumber = body && body.user_number;
  console.log('Status:', status, '| User:', userNumber);

  var toolName = body && (body.name || body.tool_name ||
    (body.tool_call && body.tool_call.name) ||
    (body.function && body.function.name) ||
    (body.task && body.task.name)) || '';

  // ── CASE 0: Returning caller lookup ──
  if (toolName === 'get_lead_data' || (status === 'initiated' && userNumber)) {
    var lookupPhone = (userNumber || '').replace('+', '').replace(/\s/g, '');
    console.log('Looking up lead for:', lookupPhone);
    var lead = await getLeadByPhone(lookupPhone);
    if (lead) {
      console.log('Returning caller:', lead.name, '| event:', lead.event_type, '| calls:', lead.call_count);
      return res.json({
        result: 'returning_caller',
        is_returning: true,
        name: lead.name || '',
        event_type: lead.event_type || '',
        venue: lead.venue || '',
        guest_count: lead.guest_count || '',
        event_date: lead.event_date || '',
        call_count: lead.call_count || 0
      });
    }
    return res.json({ result: 'new_caller', is_returning: false });
  }

  // ── CASE 1: Completed call ──
  if (status === 'completed' && userNumber) {
    var phone = userNumber.replace('+', '').replace(/\s/g, '');
    var transcript = body.transcript || '';
    var durationSeconds = parseDuration(body);
    console.log('COMPLETED CALL for:', phone, '| duration:', durationSeconds + 's');

    var extracted = extractFromTranscript(transcript);
    var extractions = body.custom_extractions || body.extracted_data || null;
    if (extractions && typeof extractions === 'object') {
      if (cleanVal(extractions.customer_name)) extracted.name = cleanVal(extractions.customer_name);
      if (cleanVal(extractions.event_type)) extracted.event_type = cleanVal(extractions.event_type);
      if (extractions.venue_booked !== undefined) extracted.venue_booked = extractions.venue_booked;
      if (cleanVal(extractions.venue_name)) extracted.venue_name = cleanVal(extractions.venue_name);
      if (cleanVal(String(extractions.guest_count || ''))) extracted.guest_count = cleanVal(String(extractions.guest_count || ''));
      if (cleanVal(extractions.event_date)) extracted.event_date = cleanVal(extractions.event_date);
    }

    var savedLead = await getLeadByPhone(phone);

    var data = {
      phone: phone,
      name: cleanVal(extracted.name) || (savedLead && savedLead.name) || 'Guest',
      event_type: cleanVal(extracted.event_type) || (savedLead && savedLead.event_type) || '',
      venue_booked: extracted.venue_booked || false,
      venue_name: cleanVal(extracted.venue_name) || (savedLead && savedLead.venue) || '',
      guest_count: cleanVal(extracted.guest_count) || (savedLead && String(savedLead.guest_count || '')) || '',
      event_date: cleanVal(extracted.event_date) || (savedLead && savedLead.event_date) || null,
      duration_seconds: durationSeconds
    };

    console.log('Extracted data:', JSON.stringify(data));
    res.json({ status: 'received' });
    handleWhatsAppFlow(data).catch(function(e) { console.error('Flow error:', e); });
    return;
  }

  // ── CASE 2: save_lead_data tool ──
  var args = body && (body.arguments || body.parameters || body.data || body.input) || body;
  var toolPhone = ((body && (body.phone || body.from_number || body.user_number)) || '').replace('+', '').replace(/\s/g, '');

  if (toolName === 'save_lead_data' || (args && args.event_type && args.name)) {
    var toolData = {
      phone: toolPhone || (args && args.phone) || '',
      name: cleanVal((args && args.name) || '') || 'Guest',
      event_type: cleanVal((args && args.event_type) || ''),
      venue_booked: (args && args.venue_booked) || false,
      venue_name: cleanVal((args && args.venue_name) || ''),
      guest_count: cleanVal(String((args && args.guest_count) || '')),
      event_date: cleanVal((args && args.event_date) || '') || null,
      duration_seconds: parseDuration(body)
    };
    console.log('TOOL save_lead_data:', JSON.stringify(toolData));
    res.json({ result: 'Lead saved! WhatsApp message is being sent.' });
    handleWhatsAppFlow(toolData).catch(function(e) { console.error('Flow error:', e); });
    return;
  }

  // ── CASE 3: get_venue_list tool ──
  if (toolName === 'get_venue_list') {
    return res.json({
      result: 'Hamare 7 partner venues: 1) Sky Blue Banquet Hall - Ravet (4.7) 2) Thopate Banquets - Rahatani 3) Blue Water Banquet - Punawale (5.0) 4) RamKrishna Veg Banquet - Ravet (4.4) 5) Shree Krishna Palace - Pimpri (4.3) 6) Raghunandan AC Banquet - Tathawade (4.0) 7) Rangoli Banquet Hall - Chinchwad (4.3). Sab Pimpri-Chinchwad Pune mein hain.'
    });
  }

  res.json({ status: 'received' });
});

app.get('/phoenix-bolna-agent', function(req, res) {
  res.json({ status: 'webhook active' });
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Phoenix Webhook Server VERSION 6 running on port ' + PORT);
});
