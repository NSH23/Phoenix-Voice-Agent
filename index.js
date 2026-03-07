const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());

const SUPABASE_URL = 'https://fhhwfqlbgmsscmqihjyz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZoaHdmcWxiZ21zc2NtcWloanl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MzgwNTksImV4cCI6MjA4NzAxNDA1OX0.T1n19S4_D7eNX4bz9AovBXwKrwOjGxvrzFGpO4nNxJ4';
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = '1023140200877702';

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

async function sendWhatsApp(phone, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    console.log(`✅ WhatsApp sent to ${phone}`);
  } catch (err) {
    console.error('❌ WhatsApp error:', JSON.stringify(err.response?.data || err.message));
  }
}

async function sendWhatsAppImage(phone, imageUrl, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'image', image: { link: imageUrl, caption } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    console.log(`✅ WhatsApp image sent to ${phone}`);
  } catch (err) {
    console.error('❌ WhatsApp image error:', JSON.stringify(err.response?.data || err.message));
  }
}

async function getEventImage(eventType) {
  try {
    const key = `event_${eventType.toLowerCase().replace(/ /g, '_')}_image`;
    const res = await supabase.get(`/rest/v1/workflow_content?content_key=eq.${key}&select=text_content&is_active=eq.true`);
    return res.data?.[0]?.text_content || null;
  } catch { return null; }
}

async function saveVoiceCall(data) {
  try {
    await supabase.post('/rest/v1/voice_calls', {
      phone: data.phone, name: data.name, call_type: 'inbound', call_status: 'completed',
      gathered_event_type: data.event_type, gathered_venue: data.venue_name,
      gathered_guest_count: data.guest_count, gathered_event_date: data.event_date, whatsapp_sent: false
    });
    console.log(`✅ Voice call saved for ${data.phone}`);
  } catch (err) {
    console.error('❌ Supabase error:', JSON.stringify(err.response?.data || err.message));
  }
}

async function updateLead(phone, eventType) {
  try {
    await supabase.patch(`/rest/v1/leads?phone=eq.${phone}`, {
      event_type: eventType, voice_qualified: true,
      last_call_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    console.log(`✅ Lead updated for ${phone}`);
  } catch (err) {
    console.error('❌ Lead update error:', JSON.stringify(err.response?.data || err.message));
  }
}

async function markWhatsAppSent(phone) {
  try {
    await supabase.patch(`/rest/v1/voice_calls?phone=eq.${phone}&whatsapp_sent=eq.false`,
      { whatsapp_sent: true, updated_at: new Date().toISOString() });
  } catch {}
}

async function handleWhatsAppFlow(data) {
  console.log('🚀 Starting WhatsApp flow for:', JSON.stringify(data));
  await saveVoiceCall(data);
  await updateLead(data.phone, data.event_type);

  if (data.venue_booked === true || data.venue_booked === 'true') {
    await sendWhatsApp(data.phone,
      `🎉 ${data.name} ji!\n\nPhoenix Events mein aapka swagat hai!\n\n🎊 Event: ${data.event_type}\n🏛️ Venue: ${data.venue_name || 'Aapka selected venue'}\n\nHum abhi aapke venue ke liye hamare kaam ki images bhej rahe hain! ✨\n\nHamara specialist 5 ghante mein contact karega.\n🌐 phoenixeventsandproduction.com`
    );
  } else {
    await sendWhatsApp(data.phone,
      `🏛️ ${data.name} ji!\n\nPhoenix Events ke saath aapki baat achi lagi! 😊\n\nHamare 7 premium partner venues Pimpri-Chinchwad mein:\n\n1️⃣ Sky Blue Banquet Hall — Ravet ⭐4.7\n2️⃣ Thopate Banquets — Rahatani\n3️⃣ Blue Water Banquet Hall — Punawale ⭐5.0\n4️⃣ RamKrishna Veg Banquet — Ravet ⭐4.4\n5️⃣ Shree Krishna Palace — Pimpri ⭐4.3\n6️⃣ Raghunandan AC Banquet — Tathawade ⭐4.0\n7️⃣ Rangoli Banquet Hall — Chinchwad ⭐4.3\n\nInme se koi pasand aaye toh batao! 🎊\n\n🌐 phoenixeventsandproduction.com`
    );
  }

  if (data.event_type) {
    const imageUrl = await getEventImage(data.event_type);
    if (imageUrl) {
      await sendWhatsAppImage(data.phone, imageUrl,
        `✨ ${data.event_type} ke liye hamare kaam ki jhalak! Aisa hi banayenge hum aapka event! 🎉`);
    }
  }

  await sendWhatsApp(data.phone,
    `✨ ${data.name} ji, Phoenix Events mein aapka swagat hai!\n\nAapki details:\n🎊 Event: ${data.event_type || 'TBD'}\n👥 Guests: ${data.guest_count || 'TBD'}\n📅 Date: ${data.event_date || 'TBD'}\n\nHamara specialist 5 ghante mein aapko call karega ek customised proposal ke saath! 🎉\n\n🌐 phoenixeventsandproduction.com\n\n'menu' type karein aur hamare services dekhein!`
  );

  await markWhatsAppSent(data.phone);
  console.log('✅ WhatsApp flow complete for:', data.phone);
}

app.get('/', (req, res) => {
  res.json({ status: 'Phoenix Events Webhook Server is running! 🚀' });
});

app.post('/phoenix-bolna-agent', async (req, res) => {
  console.log('\n═══════════════════════════════════');
  console.log('📞 NEW WEBHOOK REQUEST');
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  console.log('Query:', JSON.stringify(req.query));
  console.log('═══════════════════════════════════');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }

  const toolName = body?.name || body?.tool_call?.name || body?.function?.name || '';
  const args = body?.arguments || body?.tool_call?.arguments || body?.function?.arguments || body?.data || body || {};
  const phone = (body?.call?.customer?.number || body?.from_number || body?.phone || req.query?.phone || '').replace('+', '').replace(/\s/g, '');

  console.log('🔧 Tool:', toolName, '| Phone:', phone, '| Args:', JSON.stringify(args));

  if (toolName === 'save_lead_data' || (args?.event_type && args?.name)) {
    const data = {
      phone: phone || args?.phone || '',
      name: args?.name || 'Guest',
      event_type: args?.event_type || '',
      venue_booked: args?.venue_booked || false,
      venue_name: args?.venue_name || '',
      guest_count: args?.guest_count || '',
      event_date: args?.event_date || ''
    };
    console.log('✅ save_lead_data triggered:', JSON.stringify(data));
    res.json({ result: 'Lead saved. Sending WhatsApp now!' });
    handleWhatsAppFlow(data).catch(console.error);
    return;
  }

  if (toolName === 'get_venue_list') {
    console.log('✅ get_venue_list triggered');
    return res.json({
      result: 'Sky Blue Banquet Hall (Ravet ⭐4.7), Thopate Banquets (Rahatani), Blue Water Banquet Hall (Punawale ⭐5.0), RamKrishna Veg Banquet (Ravet ⭐4.4), Shree Krishna Palace (Pimpri ⭐4.3), Raghunandan AC Banquet (Tathawade ⭐4.0), Rangoli Banquet Hall (Chinchwad ⭐4.3) — all in Pimpri-Chinchwad Pune.'
    });
  }

  console.log('⚠️ Unknown event. Full body:', JSON.stringify(body));
  res.json({ status: 'received' });
});

app.get('/phoenix-bolna-agent', (req, res) => {
  res.json({ status: 'webhook active' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Phoenix Webhook Server running on port ${PORT}`);
});
