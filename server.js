const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static('frontend/client'));

const supabaseUrl = 'https://hgteqscrpglafdjmhnuc.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhndGVxc2NycGdsYWZkam1obnVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MTE3MjEsImV4cCI6MjA5Mjk4NzcyMX0.CjLEEFyk91yc3-QSmzYoyRNvGfsbeQtC6kO5sCe2NPQ';
const supabase = createClient(supabaseUrl, supabaseKey);

const JWT_SECRET = 'resto-secret-key-2024';
const PUBLIC_URL = 'https://restapp-a8ac.onrender.com';

// ===== MIDDLEWARE =====
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token invalide' });
  }
}

function checkRole(allowedRoles) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Non autorisé' });
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!allowedRoles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Accès interdit. Vous n\'avez pas les droits nécessaires.' });
      }
      req.user = decoded;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Token invalide' });
    }
  };
}

// ===== AUTHENTIFICATION =====
app.post('/api/auth/login', async (req, res) => {
  const { email, role } = req.body;
  
  console.log('Tentative de connexion:', email, 'rôle demandé:', role);
  
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();
  
  console.log('Résultat:', profile, error);
  
  if (error || !profile) {
    return res.status(401).json({ error: 'Email non reconnu' });
  }
  
  if (role && profile.role !== role) {
    return res.status(401).json({ error: `Accès non autorisé. Vous êtes ${profile.role}, pas ${role}.` });
  }
  
  const token = jwt.sign(
    { id: profile.id, email: profile.email, restaurant_name: profile.restaurant_name, role: profile.role || 'gerant' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({ success: true, token, user: profile });
});

app.post('/api/auth/verify', authMiddleware, async (req, res) => {
  res.json({ success: true, user: req.user });
});

// ===== ROUTES CLIENT (publiques) =====
app.get('/api/menu/:restoId', async (req, res) => {
  const { restoId } = req.params;
  
  const { data, error } = await supabase
    .from('menus')
    .select('*')
    .eq('resto_id', restoId)
    .eq('disponible', true);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/commande', async (req, res) => {
  const { restoId, tableId, items, total } = req.body;
  
  const { data: commande, error: commandeError } = await supabase
    .from('commandes')
    .insert({ resto_id: restoId, table_id: tableId, total: total })
    .select()
    .single();
  
  if (commandeError) return res.status(500).json({ error: commandeError.message });
  
  for (const item of items) {
    await supabase.from('commande_details').insert({
      commande_id: commande.id,
      menu_id: item.menuId,
      quantite: item.quantite,
      prix_unitaire: item.prix,
      nom_plat: item.nom
    });
  }
  
  io.to(`resto_${restoId}`).emit('nouvelle_commande', {
    commande_id: commande.id,
    table_id: tableId,
    items,
    total
  });
  
  res.json({ success: true, commande_id: commande.id });
});

app.put('/api/commande/:id/statut', async (req, res) => {
  const { id } = req.params;
  const { statut, restoId } = req.body;
  
  const { error } = await supabase
    .from('commandes')
    .update({ statut: statut })
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  
  io.to(`resto_${restoId}`).emit('statut_change', { commande_id: id, statut });
  res.json({ success: true });
});

app.post('/api/payer', async (req, res) => {
  const { commande_id, restoId } = req.body;
  
  const { error } = await supabase
    .from('commandes')
    .update({ statut: 'paye', paye_le: new Date() })
    .eq('id', commande_id);
  
  if (error) return res.status(500).json({ error: error.message });
  
  io.to(`resto_${restoId}`).emit('commande_payee', { commande_id });
  res.json({ success: true });
});

// Route API QR Code (retourne JSON avec l'image)
app.get('/api/qrcode/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  
  try {
    const qrImage = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    res.json({ success: true, qr: qrImage, url });
  } catch (error) {
    console.error('Erreur QR Code:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route IMAGE QR Code (pour <img src="">)
app.get('/api/qrcode-image/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  
  try {
    const qrImage = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    // Extraire le base64
    const base64 = qrImage.replace(/^data:image\/png;base64,/, '');
    const imgBuffer = Buffer.from(base64, 'base64');
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(imgBuffer);
  } catch (error) {
    console.error('Erreur QR Code Image:', error);
    res.status(500).send('Erreur génération QR code');
  }
});

app.get('/api/commandes/:restoId', async (req, res) => {
  const { restoId } = req.params;
  
  const { data: commandes, error } = await supabase
    .from('commandes')
    .select(`
      *,
      tables (numero_table),
      commande_details (quantite, prix_unitaire, nom_plat)
    `)
    .eq('resto_id', restoId)
    .order('date_commande', { ascending: false });
  
  if (error) return res.status(500).json({ error: error.message });
  
  const result = commandes.map(cmd => ({
    id: cmd.id,
    table_id: cmd.table_id,
    table_numero: cmd.tables?.numero_table,
    statut: cmd.statut,
    total: cmd.total,
    date_commande: cmd.date_commande,
    details: cmd.commande_details || []
  }));
  
  res.json(result);
});

// ===== ROUTES ADMIN (réservées au gérant) =====
app.post('/api/admin/plat', checkRole(['gerant']), async (req, res) => {
  const { restoId, nom_plat, prix, categorie, disponible, description } = req.body;
  
  const { data, error } = await supabase
    .from('menus')
    .insert({ resto_id: restoId, nom_plat, prix, categorie, disponible, description })
    .select();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.put('/api/admin/plat/:id/disponible', checkRole(['gerant']), async (req, res) => {
  const { id } = req.params;
  const { disponible } = req.body;
  
  const { error } = await supabase
    .from('menus')
    .update({ disponible })
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/admin/plat/:id', checkRole(['gerant']), async (req, res) => {
  const { id } = req.params;
  
  const { error } = await supabase
    .from('menus')
    .delete()
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ===== ROUTES STATISTIQUES (réservées au gérant) =====
app.get('/api/stats/:restoId', checkRole(['gerant']), async (req, res) => {
  const { restoId } = req.params;
  const { periode } = req.query;
  
  let startDate = null;
  const now = new Date();
  
  if (periode === 'day') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (periode === 'week') {
    startDate = new Date(now.setDate(now.getDate() - 7));
  } else if (periode === 'month') {
    startDate = new Date(now.setMonth(now.getMonth() - 1));
  }
  
  let query = supabase
    .from('commandes')
    .select('id, total, date_commande')
    .eq('resto_id', restoId)
    .eq('statut', 'paye');
  
  if (startDate) {
    query = query.gte('date_commande', startDate.toISOString());
  }
  
  const { data: commandes, error: commandesError } = await query;
  if (commandesError) return res.status(500).json({ error: commandesError.message });
  
  const caTotal = commandes.reduce((sum, cmd) => sum + (cmd.total || 0), 0);
  const nbCommandes = commandes.length;
  const panierMoyen = nbCommandes > 0 ? caTotal / nbCommandes : 0;
  
  if (commandes.length === 0) {
    return res.json({ caTotal: 0, nbCommandes: 0, panierMoyen: 0, topPlats: [], evolution: [] });
  }
  
  const commandeIds = commandes.map(c => c.id);
  const { data: details } = await supabase
    .from('commande_details')
    .select('nom_plat, quantite, prix_unitaire')
    .in('commande_id', commandeIds);
  
  const ventesParPlat = {};
  if (details) {
    details.forEach(detail => {
      if (ventesParPlat[detail.nom_plat]) {
        ventesParPlat[detail.nom_plat] += detail.quantite;
      } else {
        ventesParPlat[detail.nom_plat] = detail.quantite;
      }
    });
  }
  
  const topPlats = Object.entries(ventesParPlat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nom, quantite]) => ({ nom, quantite }));
  
  const evolutionParJour = {};
  commandes.forEach(cmd => {
    const date = new Date(cmd.date_commande).toLocaleDateString('fr-FR');
    evolutionParJour[date] = (evolutionParJour[date] || 0) + cmd.total;
  });
  
  const evolution = Object.entries(evolutionParJour)
    .sort((a, b) => new Date(a[0]) - new Date(b[0]))
    .map(([date, total]) => ({ date, total }));
  
  res.json({ caTotal, nbCommandes, panierMoyen, topPlats, evolution, periode });
});

// ===== ROUTES TABLES (réservées au gérant) =====
app.get('/api/tables/:restoId', checkRole(['gerant']), async (req, res) => {
  const { restoId } = req.params;
  
  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('resto_id', restoId)
    .order('numero_table');
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tables', checkRole(['gerant']), async (req, res) => {
  const { restoId, numeroTable } = req.body;
  
  const { data, error } = await supabase
    .from('tables')
    .insert({ resto_id: restoId, numero_table: numeroTable })
    .select();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.delete('/api/tables/:id', checkRole(['gerant']), async (req, res) => {
  const { id } = req.params;
  
  const { error } = await supabase
    .from('tables')
    .delete()
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/generate-qr/:restoId/:tableId', checkRole(['gerant']), async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  const qrImage = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>QR Code Table ${tableId}</title>
    <style>
      body { font-family: Arial; text-align: center; padding: 50px; }
      img { width: 250px; height: 250px; }
      .resto-name { font-size: 24px; font-weight: bold; margin-bottom: 20px; color: #1A1A2E; }
      .table-number { font-size: 48px; color: #C6A43F; margin: 20px 0; font-weight: bold; }
      .instruction { color: #666; margin-top: 30px; }
    </style>
    </head>
    <body>
      <div class="resto-name">🍽️ RESTAURANT ÉLITE</div>
      <div class="table-number">TABLE ${tableId}</div>
      <img src="${qrImage}">
      <div class="instruction">📱 Scannez ce code pour accéder au menu</div>
      <div class="instruction" style="font-size: 10px; margin-top: 10px;">${url}</div>
    </body>
    </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ===== ROUTES PHOTOS (réservées au gérant) =====
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload-plat-photo/:platId', checkRole(['gerant']), upload.single('photo'), async (req, res) => {
  const { platId } = req.params;
  const file = req.file;
  
  if (!file) return res.status(400).json({ error: 'Aucune photo' });
  
  const fileName = `plat_${platId}_${Date.now()}.jpg`;
  const filePath = `plats/${fileName}`;
  
  const { error } = await supabase.storage
    .from('plat-photos')
    .upload(filePath, file.buffer, { contentType: file.mimetype });
  
  if (error) return res.status(500).json({ error: error.message });
  
  const { data: urlData } = supabase.storage
    .from('plat-photos')
    .getPublicUrl(filePath);
  
  await supabase.from('menus').update({ photo_url: urlData.publicUrl }).eq('id', platId);
  
  res.json({ success: true, photoUrl: urlData.publicUrl });
});

app.delete('/api/delete-photo/:platId', checkRole(['gerant']), async (req, res) => {
  const { platId } = req.params;
  
  const { data: plat } = await supabase.from('menus').select('photo_url').eq('id', platId).single();
  
  if (plat?.photo_url) {
    const path = plat.photo_url.split('/').slice(-2).join('/');
    await supabase.storage.from('plat-photos').remove([path]);
  }
  
  await supabase.from('menus').update({ photo_url: null }).eq('id', platId);
  res.json({ success: true });
});

// ===== WEBSOCKETS =====
io.on('connection', (socket) => {
  console.log('🟢 Client connecté');
  socket.on('join_resto', (restoId) => {
    socket.join(`resto_${restoId}`);
  });
});

// ===== SUIVI COMMANDE POUR CLIENT =====
app.get('/api/commande/suivi/:id', async (req, res) => {
  const { id } = req.params;
  
  const { data: commande, error: cmdError } = await supabase
    .from('commandes')
    .select('*')
    .eq('id', id)
    .single();
  
  if (cmdError || !commande) {
    return res.status(404).json({ error: 'Commande non trouvée' });
  }
  
  const { data: details, error: detError } = await supabase
    .from('commande_details')
    .select('nom_plat, quantite, prix_unitaire')
    .eq('commande_id', id);
  
  if (detError) return res.status(500).json({ error: detError.message });
  
  res.json({
    id: commande.id,
    statut: commande.statut,
    total: commande.total,
    date_commande: commande.date_commande,
    details: details || []
  });
});

// ===== LANCEMENT =====
server.listen(3001, '0.0.0.0', () => {
  console.log('🚀 Serveur sur http://localhost:3001');
});