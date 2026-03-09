const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = 'https://fhhwfqlbgmsscmqihjyz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZoaHdmcWxiZ21zc2NtcWloanl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MzgwNTksImV4cCI6MjA4NzAxNDA1OX0.T1n19S4_D7eNX4bz9AovBXwKrwOjGxvrzFGpO4nNxJ4';
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

async function sendWhatsApp(phone, message) {
  try {
    var fullPhone = phone.startsWith("+") ? phone : "+" + phone;
    var resp = await axios.post(
      "https://graph.facebook.com/v18.0/" + WA_PHONE_ID + "/messages",
      { messaging_product: "whatsapp", to: fullPhone, type: "text", text: { body: message } },
      { headers: { Authorization: "Bearer " + WA_TOKEN } }
    );
    console.log("✅ WA sent to " + fullPhone + " | " + JSON.stringify(resp.data));
  } catch (err) {
    console.error("❌ WA FAILED:", JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function sendWhatsAppImage(phone, imageUrl, caption) {
  try {
    var fullPhone = phone.startsWith("+") ? phone : "+" + phone;
    var resp = await axios.post(
      "https://graph.facebook.com/v18.0/" + WA_PHONE_ID + "/messages",
      { messaging_product: "whatsapp", to: fullPhone, type: "image", image: { link: imageUrl, caption: caption } },
      { headers: { Authorization: "Bearer " + WA_TOKEN } }
    );
    console.log("✅ WA image sent to " + fullPhone + " | " + JSON.stringify(resp.data));
  } catch (err) {
    console.error("❌ WA image FAILED:", JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function getEventImage(eventType) {
  try {
    var key = 'event_' + eventType.toLowerCase().replace(/ /g, '_') + '_image';
    var res = await supabase.get('/rest/v1/workflow_content?content_key=eq.' + key + '&select=text_content&is_active=eq.true');
    return res.data && res.data[0] ? res.data[0].text_content : null;
  } catch (e) { return null; }
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
      gathered_guest_count: data.guest_count,
      gathered_event_date: data.event_date || null,
      whatsapp_sent: false
    });
    console.log('Voice call saved for ' + data.phone);
  } catch (err) {
    console.error('Supabase save error:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function updateLead(phone, eventType) {
  try {
    await supabase.patch('/rest/v1/leads?phone=eq.' + phone, {
      event_type: eventType,
      voice_qualified: true,
      last_call_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    console.log('Lead updated for ' + phone);
  } catch (err) {
    console.error('Lead update error:', JSON.stringify(err.response ? err.response.data : err.message));
  }
}

async function markWhatsAppSent(phone) {
  try {
    await supabase.patch('/rest/v1/voice_calls?phone=eq.' + phone + '&whatsapp_sent=eq.false',
      { whatsapp_sent: true, updated_at: new Date().toISOString() });
  } catch (e) {}
}

// Extract lead data from transcript using simple keyword matching
function extractFromTranscript(transcript) {
  var data = { name: 'Guest', event_type: '', venue_booked: false, venue_name: '', guest_count: '', event_date: '' };
  if (!transcript) return data;

  // Extract name - look for "मेरा नाम X है" or "I am X" or "my name is X"
  var nameMatch = transcript.match(/मेरा नाम ([^\n,।]+)/i) ||
                  transcript.match(/my name is ([^\n,।]+)/i) ||
                  transcript.match(/I am ([^\n,।]+)/i);
  if (nameMatch) data.name = nameMatch[1].trim().split(' ')[0];

  // Extract event type
  var events = ['wedding', 'birthday', 'engagement', 'sangeet', 'haldi', 'mehendi', 'anniversary', 'corporate', 'शादी', 'जन्मदिन', 'सगाई'];
  for (var i = 0; i < events.length; i++) {
    if (transcript.toLowerCase().indexOf(events[i].toLowerCase()) !== -1) {
      data.event_type = events[i];
      break;
    }
  }

  // Extract venue booked status
  if (transcript.indexOf('नहीं') !== -1 || transcript.toLowerCase().indexOf('no') !== -1) {
    data.venue_booked = false;
  }

  // Extract guest count
  var guestMatch = transcript.match(/(\d+)\s*guest/i) ||
                   transcript.match(/(\d+)\s*मेहमान/i) ||
                   transcript.match(/hundred/i);
  if (guestMatch) {
    data.guest_count = guestMatch[0].indexOf('hundred') !== -1 ? '100' : guestMatch[1];
  }

  return data;
}

async function handleWhatsAppFlow(data) {
  console.log('Starting WA flow:', JSON.stringify(data));
  await saveVoiceCall(data);
  await updateLead(data.phone, data.event_type);

  if (data.venue_booked === true || data.venue_booked === 'true') {
    await sendWhatsApp(data.phone,
      '🎉 ' + data.name + ' ji!\n\nPhoenix Events mein aapka swagat hai!\n\n' +
      '🎊 Event: ' + data.event_type + '\n🏛️ Venue: ' + (data.venue_name || 'Aapka selected venue') + '\n\n' +
      'Hum abhi aapke venue ke liye hamare kaam ki images bhej rahe hain!\n\n' +
      'Hamara specialist 5 ghante mein contact karega.\n🌐 phoenixeventsandproduction.com');
  } else {
    await sendWhatsApp(data.phone,
      '🏛️ ' + data.name + ' ji!\n\nPhoenix Events ke saath aapki baat achi lagi! 😊\n\n' +
      'Hamare 7 premium partner venues Pimpri-Chinchwad mein:\n\n' +
      '1️⃣ Sky Blue Banquet Hall — Ravet ⭐4.7\n' +
      '2️⃣ Thopate Banquets — Rahatani\n' +
      '3️⃣ Blue Water Banquet Hall — Punawale ⭐5.0\n' +
      '4️⃣ RamKrishna Veg Banquet — Ravet ⭐4.4\n' +
      '5️⃣ Shree Krishna Palace — Pimpri ⭐4.3\n' +
      '6️⃣ Raghunandan AC Banquet — Tathawade ⭐4.0\n' +
      '7️⃣ Rangoli Banquet Hall — Chinchwad ⭐4.3\n\n' +
      'Inme se koi pasand aaye toh batao! 🎊\n\n🌐 phoenixeventsandproduction.com');
  }

  if (data.event_type) {
    var imageUrl = await getEventImage(data.event_type);
    if (imageUrl) {
      await sendWhatsAppImage(data.phone, imageUrl,
        data.event_type + ' ke liye hamare kaam ki jhalak! Aisa hi banayenge hum aapka event!');
    }
  }

  await sendWhatsApp(data.phone,
    '✨ ' + data.name + ' ji, Phoenix Events mein aapka swagat hai!\n\n' +
    'Aapki details:\n' +
    '🎊 Event: ' + (data.event_type || 'TBD') + '\n' +
    '👥 Guests: ' + (data.guest_count || 'TBD') + '\n' +
    '📅 Date: ' + (data.event_date || 'TBD') + '\n\n' +
    'Hamara specialist 5 ghante mein aapko call karega! 🎉\n\n' +
    '🌐 phoenixeventsandproduction.com');

  await markWhatsAppSent(data.phone);
  console.log('WA flow complete for ' + data.phone);
}

app.get('/', function(req, res) {
  res.json({ status: 'Phoenix Events Webhook Server is running! VERSION 4' });
});

app.post('/phoenix-bolna-agent', async function(req, res) {
  console.log('=== NEW REQUEST ===');

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {}
  }

  console.log('Status:', body && body.status);
  console.log('User number:', body && body.user_number);

  // ── CASE 1: Completed call from Analytics webhook ──
  if (body && body.status === 'completed' && body.user_number) {
    var phone = body.user_number.replace('+', '').replace(/\s/g, '');
    var transcript = body.transcript || '';

    console.log('COMPLETED CALL detected for phone:', phone);

    // Extract data from transcript
    var extracted = extractFromTranscript(transcript);

    // Try custom_extractions first if available
    var extractions = body.custom_extractions || body.extracted_data || null;
    if (extractions && typeof extractions === 'object') {
      extracted.name = extractions.customer_name || extracted.name;
      extracted.event_type = extractions.event_type || extracted.event_type;
      extracted.venue_booked = extractions.venue_booked || extracted.venue_booked;
      var vn = extractions.venue_name;
      extracted.venue_name = (vn && typeof vn === 'string') ? vn : extracted.venue_name;
      extracted.guest_count = extractions.guest_count || extracted.guest_count;
      var ed = extractions.event_date;
      extracted.event_date = (ed && typeof ed === 'string') ? ed : extracted.event_date;
    }

    var data = {
      phone: phone,
      name: extracted.name || 'Guest',
      event_type: extracted.event_type || '',
      venue_booked: extracted.venue_booked || false,
      venue_name: (extracted.venue_name && typeof extracted.venue_name === 'string') ? extracted.venue_name : '',
      guest_count: extracted.guest_count || '',
      event_date: (extracted.event_date && extracted.event_date !== '') ? extracted.event_date : null
    };

    console.log('Extracted data:', JSON.stringify(data));
    res.json({ status: 'received' });
    handleWhatsAppFlow(data).catch(function(e) { console.error('Flow error:', e); });
    return;
  }

  // ── CASE 2: Direct tool call save_lead_data ──
  var toolName = '';
  if (body) {
    toolName = body.name || body.tool_name ||
      (body.tool_call && body.tool_call.name) ||
      (body.function && body.function.name) ||
      (body.task && body.task.name) || '';
  }
  // Bolna sends tool args at top level or nested
  var args = body && (body.arguments || body.parameters || body.data || body.input) ? 
    (body.arguments || body.parameters || body.data || body.input) : body;
  var phone = body && (body.phone || body.from_number || body.user_number ||
    (body.call && body.call.customer && body.call.customer.number)) || '';
  phone = phone.replace('+', '').replace(/\s/g, '');
  
  console.log('Tool name detected:', toolName);
  console.log('Args keys:', Object.keys(args || {}));

  if (toolName === 'save_lead_data' || (args && args.event_type && args.name)) {
    var data = {
      phone: phone || (args && args.phone) || '',
      name: (args && args.name) || 'Guest',
      event_type: (args && args.event_type) || '',
      venue_booked: (args && args.venue_booked) || false,
      venue_name: (args && args.venue_name) || '',
      guest_count: (args && args.guest_count) || '',
      event_date: (args && args.event_date) || ''
    };
    console.log('TOOL CALL save_lead_data:', JSON.stringify(data));
    res.json({ result: 'Lead saved. Sending WhatsApp now!' });
    handleWhatsAppFlow(data).catch(function(e) { console.error('Flow error:', e); });
    return;
  }

  // ── CASE 3: get_venue_list ──
  if (toolName === 'get_venue_list') {
    return res.json({ result: 'Sky Blue Banquet Ravet 4.7, Thopate Banquets Rahatani, Blue Water Punawale 5.0, RamKrishna Veg Ravet 4.4, Shree Krishna Pimpri 4.3, Raghunandan Tathawade 4.0, Rangoli Chinchwad 4.3 - all Pimpri-Chinchwad Pune.' });
  }

  console.log('⚠️ UNHANDLED - status:', body && body.status, '| keys:', Object.keys(body || {}));
  res.json({ status: 'received' });
});

app.get('/phoenix-bolna-agent', function(req, res) {
  res.json({ status: 'webhook active' });
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Phoenix Webhook Server running on port ' + PORT);
});
