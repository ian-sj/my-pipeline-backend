const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4400;
const DB_FILE = path.join(__dirname, 'pipeline-data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      campaigns: [
        { id: 'general', title: 'All Campaigns', brand: 'General' },
        { id: 'q4-ugc', title: 'Q4 UGC Creators', brand: 'Brand Launch' },
        { id: 'tech-review', title: 'Tech & SaaS Reviewers', brand: 'Partner' }
      ],
      stages: [
        { id: 'sourced', name: 'Sourced', order: 1 },
        { id: 'contacted', name: 'Contacted', order: 2 },
        { id: 'negotiating', name: 'Negotiating', order: 3 },
        { id: 'onboarded', name: 'Onboarded', order: 4 }
      ],
      leads: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function detectPlatform(urlStr) {
  try {
    const host = new URL(urlStr).hostname.replace(/^(www|m)\./, '');
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('x.com') || host.includes('twitter.com')) return 'x';
    if (host.includes('linkedin.com')) return 'linkedin';
  } catch {}
  return null;
}

const checkAuth = (req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ugcx_') && !auth.startsWith('Bearer cs_')) {
    return res.status(401).json({ error: 'Invalid extension key (must start with ugcx_ or cs_)' });
  }
  next();
};

app.get('/me', checkAuth, (req, res) => {
  res.json({ admin: { name: 'My Pipeline', email: 'local@creatorscout' } });
});

app.get('/campaigns', checkAuth, (req, res) => {
  const db = loadDB();
  res.json({ campaigns: db.campaigns });
});

app.get('/stages', checkAuth, (req, res) => {
  const db = loadDB();
  res.json({ stages: db.stages });
});

app.get('/lookup', checkAuth, (req, res) => {
  const { url, handle } = req.query;
  const platform = detectPlatform(url || '');
  if (!platform) return res.status(400).json({ error: 'Unsupported URL' });

  const db = loadDB();
  const cleanHandle = (handle || '').replace(/^@/, '').toLowerCase();
  const lead = db.leads.find(
    (l) => l.platform === platform && (l.handle.toLowerCase() === cleanHandle || l.profile_url === url)
  );

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const elsewhere = cleanHandle
    ? db.leads
        .filter((l) => l.handle.toLowerCase() === cleanHandle && l.platform !== platform)
        .map((l) => ({
          handle: l.handle,
          platform: l.platform,
          stage: l.stage,
          pipeline_url: `${baseUrl}/`
        }))
    : [];

  const campaignObj = lead ? db.campaigns.find((c) => c.id === lead.campaignId) : null;

  res.json({
    resolved: Boolean(cleanHandle),
    parsed: { platform, handle: cleanHandle },
    lead: lead
      ? {
          ...lead,
          campaign: campaignObj || { id: 'general', title: 'All Campaigns', brand: 'General' },
          pipeline_url: `${baseUrl}/`
        }
      : null,
    elsewhere
  });
});

app.post('/source', checkAuth, (req, res) => {
  const { url, note, page, campaignId, stageId, manualEmail } = req.body;
  const platform = detectPlatform(url || '');
  if (!platform) return res.status(400).json({ error: 'Unsupported creator URL' });

  const db = loadDB();
  const handle = (page?.handle || '').replace(/^@/, '') || 'unknown';
  const existing = db.leads.find(
    (l) => l.platform === platform && l.handle.toLowerCase() === handle.toLowerCase()
  );

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  if (existing) {
    const campaignObj = db.campaigns.find((c) => c.id === existing.campaignId);
    return res.json({
      created: false,
      lead: { ...existing, campaign: campaignObj, pipeline_url: `${baseUrl}/` }
    });
  }

  const finalEmail = manualEmail || page?.detected_emails?.[0] || '';

  const newLead = {
    id: 'lead_' + Date.now(),
    profile_url: url,
    handle,
    platform,
    name: page?.name || handle,
    followers: page?.followers || null,
    avatar_url: page?.avatar_url || '',
    bio: page?.bio || '',
    links: page?.links || [],
    email: finalEmail,
    email_lookup: { status: finalEmail ? 'done' : 'running' },
    campaignId: campaignId || 'general',
    stage: stageId || 'sourced',
    note: note || '',
    created_at: new Date().toISOString(),
    created_by: { name: 'You' }
  };

  db.leads.unshift(newLead);
  saveDB(db);

  const campaignObj = db.campaigns.find((c) => c.id === newLead.campaignId);
  res.json({
    created: true,
    lead: { ...newLead, campaign: campaignObj, pipeline_url: `${baseUrl}/` }
  });
});

app.get('/leads', checkAuth, (req, res) => {
  const db = loadDB();
  const limit = parseInt(req.query.limit || '50', 10);
  res.json({ leads: db.leads.slice(0, limit) });
});

app.get('/api/board', (req, res) => {
  res.json(loadDB());
});

app.patch('/api/leads/:id', (req, res) => {
  const db = loadDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  Object.assign(lead, req.body);
  saveDB(db);
  res.json({ lead });
});

app.delete('/api/leads/:id', (req, res) => {
  const db = loadDB();
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🚀 CreatorScout Pipeline & Board running at: http://localhost:${PORT}\n`);
});
