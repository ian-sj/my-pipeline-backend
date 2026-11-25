const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 4400;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection Setup
const uri = process.env.MONGODB_URI;
let db;

async function connectDB() {
  if (!uri) {
    console.error('❌ MONGODB_URI environment variable is missing!');
    process.exit(1);
  }
  try {
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db('ian_sourcing'); // Database name
    console.log('✅ Connected successfully to MongoDB Atlas');
    
    // Initialize default collections/documents if empty
    await initializeDefaults();
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

async function initializeDefaults() {
  const campaignsCol = db.collection('campaigns');
  const count = await campaignsCol.countDocuments();
  if (count === 0) {
    await campaignsCol.insertMany([
      { id: 'general', title: 'All Campaigns', brand: 'General' },
      { id: 'q4-ugc', title: 'Q4 UGC Creators', brand: 'Brand Launch' },
      { id: 'tech-review', title: 'Tech & SaaS Reviewers', brand: 'Partner' }
    ]);
  }

  const stagesCol = db.collection('stages');
  const stageCount = await stagesCol.countDocuments();
  if (stageCount === 0) {
    await stagesCol.insertMany([
      { id: 'sourced', name: 'Sourced', order: 1 },
      { id: 'contacted', name: 'Contacted', order: 2 },
      { id: 'negotiating', name: 'Negotiating', order: 3 },
      { id: 'onboarded', name: 'Onboarded', order: 4 }
    ]);
  }
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
  res.json({ admin: { name: 'Ian Sourcing', email: 'local@iansourcing' } });
});

app.get('/campaigns', checkAuth, async (req, res) => {
  try {
    const campaigns = await db.collection('campaigns').find({}).toArray();
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// New Campaign Creation Endpoint
app.post('/api/campaigns', async (req, res) => {
  try {
    const { title, brand } = req.body;
    if (!title) return res.status(400).json({ error: 'Campaign title is required' });

    const newCampaign = {
      id: 'camp_' + Date.now(),
      title,
      brand: brand || 'General'
    };

    await db.collection('campaigns').insertOne(newCampaign);
    res.json({ campaign: newCampaign });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/stages', checkAuth, async (req, res) => {
  try {
    const stages = await db.collection('stages').find({}).sort({ order: 1 }).toArray();
    res.json({ stages });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/lookup', checkAuth, async (req, res) => {
  const { url, handle } = req.query;
  const platform = detectPlatform(url || '');
  if (!platform) return res.status(400).json({ error: 'Unsupported URL' });

  const cleanHandle = (handle || '').replace(/^@/, '').toLowerCase();
  
  try {
    const lead = await db.collection('leads').findOne({
      platform,
      $or: [
        ...(cleanHandle ? [{ handle: new RegExp(`^${cleanHandle}$`, 'i') }] : []),
        ...(url ? [{ profile_url: url }] : [])
      ]
    });

    const allLeads = await db.collection('leads').find({}).toArray();
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const elsewhere = cleanHandle
      ? allLeads
          .filter((l) => l.handle.toLowerCase() === cleanHandle && l.platform !== platform)
          .map((l) => ({
            handle: l.handle,
            platform: l.platform,
            stage: l.stage,
            pipeline_url: `${baseUrl}/`
          }))
      : [];

    let campaignObj = null;
    if (lead) {
      campaignObj = await db.collection('campaigns').findOne({ id: lead.campaignId });
    }

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
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/source', checkAuth, async (req, res) => {
  const { url, note, page, campaignId, stageId, manualEmail } = req.body;
  const platform = detectPlatform(url || '');
  if (!platform) return res.status(400).json({ error: 'Unsupported creator URL' });

  const handle = (page?.handle || '').replace(/^@/, '') || 'unknown';
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  try {
    const existing = await db.collection('leads').findOne({
      platform,
      handle: new RegExp(`^${handle}$`, 'i')
    });

    if (existing) {
      const campaignObj = await db.collection('campaigns').findOne({ id: existing.campaignId });
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

    await db.collection('leads').insertOne(newLead);

    const campaignObj = await db.collection('campaigns').findOne({ id: newLead.campaignId });
    res.json({
      created: true,
      lead: { ...newLead, campaign: campaignObj, pipeline_url: `${baseUrl}/` }
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/leads', checkAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const leads = await db.collection('leads').find({}).sort({ created_at: -1 }).limit(limit).toArray();
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/board', async (req, res) => {
  try {
    const campaigns = await db.collection('campaigns').find({}).toArray();
    const stages = await db.collection('stages').find({}).sort({ order: 1 }).toArray();
    const leads = await db.collection('leads').find({}).sort({ created_at: -1 }).toArray();
    res.json({ campaigns, stages, leads });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    delete updates._id; // Prevent updating MongoDB's internal ID

    const result = await db.collection('leads').findOneAndUpdate(
      { id: id },
      { $set: updates },
      { returnDocument: 'after' }
    );

    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ lead: result });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    const result = await db.collection('leads').deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Start server only after DB connection succeeds
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Ian Sourcing Pipeline & Board running at: http://localhost:${PORT}\n`);
  });
});
