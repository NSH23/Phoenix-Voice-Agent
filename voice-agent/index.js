const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = 'https://fhhwfqlbgmsscmqihjyz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZoaHdmcWxiZ21zc2NtcWloanl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MzgwNTksImV4cCI6MjA4NzAxNDA1OX0.T1n19S4_D7eNX4bz9AovBXwKrwOjGxvrzFGpO4nNxJ4';
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID || '1023140200877702';

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function cleanPhone(phone) {
  if (!phone) return '';
  return String(phone).replace('+', '').replace(/\s/g, '').trim();
}

function cleanVal(val) {
  if (!val) return '';
  var s = String(val).trim();
  if (s.toUpperCase() === 'NULL' || s === '{}' || s === 'undefined' || s === 'null' || s === '') return '';
  return s;
}

function validDate(val) {
  if (!val) return null;
  var s = String(val).trim();
  if (!/\d/.test(s)) return null;
  if (s.length < 4) return null;
  return s;
}

function parseDuration(body) {
  var d = body.call_duration || body.duration || body.call_length ||
    (body.metadata && body.metadata.call_duration) ||
    (body.metadata && body.metadata.duration) || 0;
  var n = parseInt(d);
  return isNaN(n) ? 0 : n;
}

function parseGuestCount(val) {
  if (!val) return null;
  var s = String(val).toLowerCase().trim();
  var maps = {
    'ek sau': 100, 'do sau': 200, 'teen sau': 300, 'char sau': 400, 'paanch sau': 500,
    'pachaas': 50, 'sau': 100, 'ek hazar': 1000, 'hazaar': 1000,
    'fifty': 50, 'one hundred': 100, 'two hundred': 200, 'three hundred': 300,
    'four hundred': 400, 'five hundred': 500, 'hundred': 100, 'thousand': 1000,
    'पचास': 50, 'सौ': 100, 'दो सौ': 200, 'तीन सौ': 300, 'हजार': 1000
  };
  for (var k in maps) { if (s.indexOf(k) !== -1) return maps[k]; }
  var n = parseInt(s.replace(/[^0-9]/g, ''));
  return isNaN(n) ? null : n;
}

var VENUES = [
  { index: 1, name: 'Sky Blue Banquet Hall', area: 'Punawale/Ravet', rating: '4.7', capacity: '100-500', features: 'AC, Parking, Stage, Catering' },
  { index: 2, name: 'Blue Water Banquet Hall', area: 'Punawale', rating: '5.0', capacity: '50-300', features: 'Premium AC, Parking' },
  { index: 3, name: 'Thopate Banquets', area: 'Rahatani', rating: '', capacity: '100-400', features: 'Parking, Stage' },
  { index: 4, name: 'RamKrishna Veg Banquet', area: 'Ravet', rating: '4.4', capacity: '50-250', features: 'Veg Only, AC, Parking' },
  { index: 5, name: 'Shree Krishna Palace', area: 'Pimpri Colony', rating: '4.3', capacity: '100-600', features: 'Large Hall, Stage, Parking' },
  { index: 6, name: 'Raghunandan AC Banquet', area: 'Tathawade', rating: '4.0', capacity: '100-350', features: 'Full AC, Parking, Stage' },
  { index: 7, name: 'Rangoli Banquet Hall', area: 'Chinchwad', rating: '4.3', capacity: '100-500', features: 'AC, Parking, Decoration Support' }
];

function getVenueIndex(venueName) {
  if (!venueName) return null;
  var lower = venueName.toLowerCase();
  for (var v = 0; v < VENUES.length; v++) {
    if (lower.indexOf(VENUES[v].name.toLowerCase().split(' ')[0].toLowerCase()) !== -1) return VENUES[v].index;
  }
  return null;
}

async function getLeadByPhone(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + cleanPhone(phone) + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { console.error('getLeadByPhone:', e.message); return null; }
}

async function getMediaByKey(key) {
  try {
    var res = await supabase.get('/rest/v1/workflow_content?content_key=eq.' + key + '&is_active=eq.true&select=text_content,media_assets(public_url)');
    if (res.data && res.data[0]) {
      if (res.data[0].media_assets && res.data[0].media_assets.public_url) return res.data[0].media_assets.public_url;
      if (res.data[0].text_content) return res.data[0].text_content;
    }
    return null;
  } catch (e) { return null; }
}

async function getEventImage(eventType) {
  if (!eventType) return null;
  var url = await getMediaByKey('event_' + eventType.toLowerCase().replace(/\s+/g, '_') + '_image');
  if (url) return url;
  try {
    var res = await supabase.get('/rest/v1/media_assets?subcategory=eq.' + eventType.toLowerCase() + '&is_active=eq.true&file_type=eq.image&select=public_url&order=sort_order.asc&limit=1');
    if (res.data && res.data[0]) return res.data[0].public_url;
  } catch (e) {}
  return null;
}

async function saveVoiceCall(data) {
  try {
    await supabase.post('/rest/v1/voice_calls', {
      phone: data.phone, name: data.name || 'Guest',
      call_type: 'inbound', call_status: 'completed',
      gathered_event_type: data.event_type || null,
      gathered_venue: data.venue_name || null,
      gathered_guest_count: parseGuestCount(data.guest_count),
      gathered_event_date: data.event_date || null,
      whatsapp_sent: false,
      duration_seconds: data.duration_seconds || 0,
      call_outcome: data.event_type ? 'data_collected' : 'no_data'
    });
  } catch (e) { console.error('saveVoiceCall:', e.message); }
}

async function logConversation(phone, content, direction) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: direction || 'inbound',
      message_type: 'voice', content: content,
      status: 'completed', channel: 'voice'
    });
  } catch (e) {}
}

async function upsertLead(data) {
  try {
    var phone = cleanPhone(data.phone);
    var existing = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    var isNew = !existing.data || existing.data.length === 0;
    var prev = isNew ? null : existing.data[0];
    var now = new Date().toISOString();

    var payload = {
      phone: phone, updated_at: now, last_interaction: now,
      last_channel: 'voice', voice_qualified: true, last_call_at: now,
      call_count: isNew ? 1 : ((prev.call_count || 0) + 1),
      call_duration_seconds: isNew ? (data.duration_seconds || 0) : ((prev.call_duration_seconds || 0) + (data.duration_seconds || 0))
    };

    if (data.name && data.name !== 'Guest' && data.name !== 'Unknown') payload.name = data.name;
    if (data.event_type) payload.event_type = data.event_type;
    if (data.venue_name) payload.venue = data.venue_name;
    if (data.guest_count) payload.guest_count = parseGuestCount(data.guest_count);
    if (data.event_date) payload.event_date = data.event_date;
    if (data.city) payload.city = data.city;
    if (data.area) payload.area = data.area;
    if (data.services_needed) payload.services_needed = data.services_needed;
    if (data.package_type) payload.package_type = data.package_type;
    if (data.function_list) payload.function_list = data.function_list;
    if (data.relationship_to_event) payload.relationship_to_event = data.relationship_to_event;
    if (data.preferred_call_time) payload.preferred_call_time = data.preferred_call_time;
    if (data.preferred_call_date) payload.preferred_call_date = data.preferred_call_date;
    if (data.language) payload.language = data.language;
    if (data.competitor_comparing !== undefined && data.competitor_comparing !== '') {
      payload.competitor_comparing = data.competitor_comparing === 'true' || data.competitor_comparing === true;
    }
    if (data.catering_needed !== undefined && data.catering_needed !== '') {
      payload.catering_needed = data.catering_needed === 'true' || data.catering_needed === true;
    }

    if (data.event_date) {
      try {
        var parts = String(data.event_date).split('/');
        if (parts.length === 3) {
          var daysUntil = Math.floor((new Date(parts[2], parts[1] - 1, parts[0]) - new Date()) / 86400000);
          payload.urgency_level = daysUntil <= 30 ? 'high' : daysUntil <= 90 ? 'medium' : 'low';
        }
      } catch (e) {}
    }

    if (isNew) {
      payload.source = 'voice_call'; payload.status = 'new';
      payload.first_channel = 'voice'; payload.whatsapp_count = 0;
      payload.lead_score = 5; payload.created_at = now;
      await supabase.post('/rest/v1/leads', payload);
      console.log('New lead created:', phone);
    } else {
      if (!prev.first_channel) payload.first_channel = 'voice';
      if (prev.status === 'qualified' || prev.status === 'converted') delete payload.status;
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, payload);
      console.log('Lead updated:', phone);
    }
  } catch (e) { console.error('upsertLead:', e.message); }
}

async function sendWhatsApp(phone, message) {
  try {
    if (!WA_TOKEN) { console.log('WA_TOKEN missing'); return; }
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    var chunks = message.length <= 4000 ? [message] : (function() {
      var arr = []; var t = message;
      while (t.length > 0) { var c = t.substring(0, 4000); arr.push(c.trim()); t = t.substring(c.length).trim(); }
      return arr;
    })();
    for (var i = 0; i < chunks.length; i++) {
      await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
        { messaging_product: 'whatsapp', to: fp, type: 'text', text: { body: chunks[i] } },
        { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
      );
      if (chunks.length > 1) await sleep(600);
    }
    console.log('WA sent to', fp);
  } catch (e) { console.error('sendWhatsApp:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendWhatsAppImage(phone, imageUrl, caption) {
  try {
    if (!WA_TOKEN || !imageUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('WA image sent to', fp);
  } catch (e) { console.error('sendWhatsAppImage:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function handleHandoffFlow(data) {
  console.log('Handoff WA flow for:', data.phone);
  var name = data.name || 'Friend';
  var ev = data.event_type || '';
  var venue = data.venue_name || '';

  // 1. Warm greeting
  var greeting = 'Heyy *' + name + '* ji! 😊 Main Aishwarya hoon Phoenix Events se — abhi aapsi baat hui!\n\n';
  if (ev && venue) {
    greeting += 'Aapke *' + ev + '* event aur *' + venue + '* ke liye kuch khoobsurat cheezein laayi hoon! ✨\n\nAbhi photos bhej rahi hoon... 📸';
  } else if (ev) {
    greeting += 'Aapke *' + ev + '* ke liye kuch beautiful photos laayi hoon! ✨\n\nAbhi bhej rahi hoon... 📸';
  } else {
    greeting += 'Phoenix Events ke kuch khoobsurat kaam ki jhalak bhejti hoon! ✨';
  }
  await sendWhatsApp(data.phone, greeting);
  await sleep(1500);

  // 2. Event portfolio image
  if (ev) {
    var eImg = await getEventImage(ev);
    if (eImg) { await sendWhatsAppImage(data.phone, eImg, '🎊 Hamare ' + ev + ' events ke kuch beautiful moments!'); await sleep(1000); }
  }

  // 3. Venue image
  if (venue) {
    var vi = getVenueIndex(venue);
    if (vi) {
      var vImg = await getMediaByKey('venue_' + vi + '_image');
      if (vImg) { await sleep(800); await sendWhatsAppImage(data.phone, vImg, '🏛️ ' + venue + ' — aapke event ke liye perfect!'); await sleep(800); }
    }
  }

  // 4. Venue list if not booked
  if (!data.venue_booked || data.venue_booked === 'false' || data.venue_booked === false) {
    await sendWhatsApp(data.phone,
      '🏛️ *Hamare 7 Premium Partner Venues — Pimpri-Chinchwad:*\n\n' +
      '1️⃣ *Sky Blue Banquet Hall* — Ravet ⭐ 4.7 | 100-500 guests\n' +
      '2️⃣ *Blue Water Banquet Hall* — Punawale ⭐ 5.0 | 50-300 guests\n' +
      '3️⃣ *Thopate Banquets* — Rahatani | 100-400 guests\n' +
      '4️⃣ *RamKrishna Veg Banquet* — Ravet ⭐ 4.4 | 50-250 guests\n' +
      '5️⃣ *Shree Krishna Palace* — Pimpri Colony ⭐ 4.3 | 100-600 guests\n' +
      '6️⃣ *Raghunandan AC Banquet* — Tathawade ⭐ 4.0 | 100-350 guests\n' +
      '7️⃣ *Rangoli Banquet Hall* — Chinchwad ⭐ 4.3 | 100-500 guests\n\n' +
      'Kisi bhi venue ki photos chahiye? Bas batao! 😊'
    );
    await sleep(1000);
  }

  // 5. Details summary + specialist CTA
  var d = '✅ *Aapki details save kar li hain!*\n\n';
  if (ev) d += '🎊 *Event:* ' + ev + '\n';
  if (data.guest_count) d += '👥 *Guests:* ' + data.guest_count + '\n';
  if (data.event_date) d += '📅 *Date:* ' + data.event_date + '\n';
  if (venue) d += '🏛️ *Venue:* ' + venue + '\n';
  if (data.services_needed) d += '✨ *Services:* ' + data.services_needed + '\n';
  if (data.package_type) d += '📦 *Package:* ' + data.package_type.charAt(0).toUpperCase() + data.package_type.slice(1) + '\n';
  if (data.preferred_call_time) d += '📞 *Preferred call time:* ' + data.preferred_call_time + '\n';
  d += '\nHamare specialist *aaj hi* aapko call karenge! 🙏\n\n' +
    'Koi bhi sawaal ho, photos chahiye ya kuch aur — bas yahan message karo! 😊\n\n' +
    '📞 *+91 80357 35856*\n🌐 phoenixeventsandproduction.com\n📸 @phoenix_events_and_production';

  await sendWhatsApp(data.phone, d);

  try {
    await supabase.patch('/rest/v1/leads?phone=eq.' + cleanPhone(data.phone), { handoff_wa_sent: true, updated_at: new Date().toISOString() });
    await supabase.patch('/rest/v1/voice_calls?phone=eq.' + cleanPhone(data.phone) + '&whatsapp_sent=eq.false', { whatsapp_sent: true });
  } catch (e) {}

  console.log('Handoff complete for', data.phone);
}

function extractFromTranscript(transcript) {
  var data = { name: '', event_type: '', venue_booked: false, venue_name: '', guest_count: '', event_date: '' };
  if (!transcript) return data;
  var nameP = [/माझं नाव ([^\n,।]+)/i, /mera naam ([^\n,।]+)/i, /my name is ([^\n,।]+)/i, /naav ([^\n,।]+)/i, /I am ([A-Z][a-z]+)/];
  for (var i = 0; i < nameP.length; i++) { var m = transcript.match(nameP[i]); if (m) { data.name = m[1].trim().split(' ')[0]; break; } }
  var events = ['wedding', 'birthday', 'engagement', 'sangeet', 'haldi', 'mehendi', 'anniversary', 'corporate', 'reception', 'baby shower', 'namkaran', 'shaadi', 'lagna'];
  for (var j = 0; j < events.length; j++) { if (transcript.toLowerCase().indexOf(events[j]) !== -1) { data.event_type = events[j].charAt(0).toUpperCase() + events[j].slice(1); break; } }
  var gm = transcript.match(/(\d+)\s*(guest|log|माणस|मेहमान)/i);
  if (gm) data.guest_count = gm[1];
  return data;
}

// ── ROUTES ──
app.get('/', function(req, res) { res.json({ status: 'Phoenix Events Voice Agent VERSION 7', timestamp: new Date().toISOString() }); });
app.get('/phoenix-bolna-agent', function(req, res) { res.json({ status: 'webhook active', version: 7 }); });

app.post('/phoenix-bolna-agent', async function(req, res) {
  console.log('\n=== BOLNA WEBHOOK ===');
  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }

  var status = cleanVal(body && body.status);
  var userNumber = cleanVal(body && (body.user_number || body.from || body.phone));
  var toolName = cleanVal(body && (body.name || body.tool_name || (body.tool_call && body.tool_call.name) || (body.function && body.function.name) || (body.task && body.task.name)));

  console.log('Tool:', toolName, '| Status:', status, '| User:', userNumber);

  // ── get_lead_data ──
  if (toolName === 'get_lead_data') {
    var phone = cleanPhone(userNumber || (body && body.user_number));
    if (!phone) return res.json({ result: 'new_caller', is_returning: false });
    var lead = await getLeadByPhone(phone);
    if (lead && lead.name && lead.name !== 'Guest') {
      return res.json({
        result: 'returning_caller', is_returning: true,
        name: lead.name || '', event_type: lead.event_type || '',
        venue: lead.venue || '', guest_count: lead.guest_count ? String(lead.guest_count) : '',
        event_date: lead.event_date || '', call_count: lead.call_count || 0,
        package_type: lead.package_type || '', services_needed: lead.services_needed || '',
        preferred_call_time: lead.preferred_call_time || '', last_channel: lead.last_channel || 'voice'
      });
    }
    return res.json({ result: 'new_caller', is_returning: false });
  }

  // ── get_venue_list ──
  if (toolName === 'get_venue_list') {
    var args = body && (body.arguments || body.parameters || body.data || {});
    var gc = parseGuestCount(cleanVal((args && args.guest_count) || ''));
    var filtered = gc ? VENUES.filter(function(v) { var max = parseInt(v.capacity.split('-').pop()); return max >= gc; }) : VENUES;
    if (!filtered.length) filtered = VENUES;
    var text = filtered.map(function(v) {
      return v.index + ') ' + v.name + ' - ' + v.area + (v.rating ? ' (' + v.rating + ' stars)' : '') + ' | ' + v.capacity + ' guests | ' + v.features;
    }).join(' | ');
    return res.json({ result: text });
  }

  // ── save_lead_data (mid-call) ──
  if (toolName === 'save_lead_data') {
    var args2 = body && (body.arguments || body.parameters || body.data || body.input) || body;
    var p2 = cleanPhone(userNumber || (args2 && args2.phone) || '');
    if (p2) {
      upsertLead({
        phone: p2, name: cleanVal(args2 && args2.name), event_type: cleanVal(args2 && args2.event_type),
        venue_booked: args2 && args2.venue_booked, venue_name: cleanVal(args2 && args2.venue_name),
        guest_count: cleanVal(String((args2 && args2.guest_count) || '')),
        event_date: validDate(cleanVal(args2 && args2.event_date)),
        city: cleanVal(args2 && args2.city), area: cleanVal(args2 && args2.area),
        services_needed: cleanVal(args2 && args2.services_needed), package_type: cleanVal(args2 && args2.package_type),
        function_list: cleanVal(args2 && args2.function_list), relationship_to_event: cleanVal(args2 && args2.relationship_to_event),
        preferred_call_time: cleanVal(args2 && args2.preferred_call_time), preferred_call_date: cleanVal(args2 && args2.preferred_call_date),
        language: cleanVal(args2 && args2.language), competitor_comparing: args2 && args2.competitor_comparing,
        catering_needed: args2 && args2.catering_needed, duration_seconds: 0
      }).catch(function(e) { console.error('mid-call save error:', e.message); });
    }
    return res.json({ result: 'Saved. Continue the conversation.' });
  }

  // ── Call completed ──
  if (status === 'completed' && userNumber) {
    var p3 = cleanPhone(userNumber);
    var dur = parseDuration(body);
    console.log('COMPLETED:', p3, dur + 's');
    var ext = extractFromTranscript(body.transcript || '');
    var ex = body.custom_extractions || body.extracted_data || body.extractions || {};
    if (typeof ex === 'object') {
      if (cleanVal(ex.customer_name)) ext.name = cleanVal(ex.customer_name);
      if (cleanVal(ex.event_type)) ext.event_type = cleanVal(ex.event_type);
      if (ex.venue_booked !== undefined) ext.venue_booked = ex.venue_booked;
      if (cleanVal(ex.venue_name)) ext.venue_name = cleanVal(ex.venue_name);
      if (ex.guest_count) ext.guest_count = cleanVal(String(ex.guest_count));
      if (ex.event_date) ext.event_date = validDate(cleanVal(ex.event_date));
      if (ex.package_type) ext.package_type = cleanVal(ex.package_type);
      if (ex.services_needed) ext.services_needed = cleanVal(ex.services_needed);
      if (ex.preferred_call_time) ext.preferred_call_time = cleanVal(ex.preferred_call_time);
      if (ex.relationship_to_event) ext.relationship_to_event = cleanVal(ex.relationship_to_event);
      if (ex.function_list) ext.function_list = cleanVal(ex.function_list);
      if (ex.language_spoken) ext.language = cleanVal(ex.language_spoken);
      if (ex.city_area) ext.city = cleanVal(ex.city_area);
      if (ex.competitor_comparing) ext.competitor_comparing = ex.competitor_comparing;
    }
    var prev2 = await getLeadByPhone(p3);
    var final = {
      phone: p3,
      name: cleanVal(ext.name) || (prev2 && prev2.name) || 'Guest',
      event_type: cleanVal(ext.event_type) || (prev2 && prev2.event_type) || '',
      venue_booked: ext.venue_booked || false,
      venue_name: cleanVal(ext.venue_name) || (prev2 && prev2.venue) || '',
      guest_count: cleanVal(ext.guest_count) || (prev2 && String(prev2.guest_count || '')) || '',
      event_date: validDate(ext.event_date) || (prev2 && prev2.event_date) || null,
      package_type: cleanVal(ext.package_type) || (prev2 && prev2.package_type) || '',
      services_needed: cleanVal(ext.services_needed) || (prev2 && prev2.services_needed) || '',
      preferred_call_time: cleanVal(ext.preferred_call_time) || (prev2 && prev2.preferred_call_time) || '',
      relationship_to_event: cleanVal(ext.relationship_to_event) || '',
      function_list: cleanVal(ext.function_list) || '',
      language: cleanVal(ext.language) || '',
      city: cleanVal(ext.city) || '',
      competitor_comparing: ext.competitor_comparing,
      duration_seconds: dur
    };
    res.json({ status: 'received' });
    saveVoiceCall(final).catch(function(e) { console.error(e.message); });
    upsertLead(final).catch(function(e) { console.error(e.message); });
    logConversation(p3, 'Voice call | ' + (final.event_type || 'no event') + ' | ' + dur + 's', 'inbound').catch(function() {});
    handleHandoffFlow(final).catch(function(e) { console.error('handoff error:', e.message); });
    return;
  }

  if (status === 'initiated' && userNumber) {
    logConversation(cleanPhone(userNumber), 'Voice call initiated', 'inbound').catch(function() {});
    return res.json({ status: 'acknowledged' });
  }

  res.json({ status: 'received' });
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() { console.log('Phoenix Events Voice Agent VERSION 7 running on port ' + PORT); });
