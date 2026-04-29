const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

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

// ===== AUTHENTIFICATION =====

// Inscription / Connexion simplifiée (sans mot de passe - code par email)

app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  
  console.log('Tentative de connexion avec:', email);
  
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();
  
  console.log('Résultat:', profile, error);
  
  if (error || !profile) {
    return res.status(401).json({ error: 'Email non reconnu' });
  }
  
  const token = jwt.sign(
    { id: profile.id, email: profile.email, restaurant_name: profile.restaurant_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({ success: true, token, user: profile });
});

// Vérifier le token
app.post('/api/auth/verify', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ success: true, user: decoded });
  } catch (error) {
    res.status(401).json({ error: 'Token invalide' });
  }
});

// ===== ROUTES PROTÉGÉES (exemple) =====
// Middleware pour protéger les routes admin
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

// Protéger la route admin
app.get('/api/admin/restaurants', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('restaurants').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== ROUTES EXISTANTES (garder toutes tes routes) =====

// 1. Récupérer le menu
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

// 2. Passer commande
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

// 3. Changer statut
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

// 4. Valider paiement
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

// 5. QR Code
app.get('/api/qrcode/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `https://restapp-a8ac.onrender.com/menu.html?resto=${restoId}&table=${tableId}`;
  const qrImage = await QRCode.toDataURL(url);
  res.json({ qr: qrImage, url });
});

// 6. Récupérer commandes
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

// ===== ROUTES ADMIN =====

app.post('/api/admin/plat', async (req, res) => {
  const { restoId, nom_plat, prix, categorie, disponible, description } = req.body;
  
  const { data, error } = await supabase
    .from('menus')
    .insert({ resto_id: restoId, nom_plat, prix, categorie, disponible, description })
    .select();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.put('/api/admin/plat/:id/disponible', async (req, res) => {
  const { id } = req.params;
  const { disponible } = req.body;
  
  const { error } = await supabase
    .from('menus')
    .update({ disponible })
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/admin/plat/:id', async (req, res) => {
  const { id } = req.params;
  
  const { error } = await supabase
    .from('menus')
    .delete()
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ===== STATISTIQUES COMPLÈTES =====

app.get('/api/stats/:restoId', async (req, res) => {
  const { restoId } = req.params;
  const { periode } = req.query;
  
  // Calculer la date de début selon la période
  let startDate = null;
  const now = new Date();
  
  if (periode === 'day') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (periode === 'week') {
    startDate = new Date(now.setDate(now.getDate() - 7));
  } else if (periode === 'month') {
    startDate = new Date(now.setMonth(now.getMonth() - 1));
  }
  
  // 1. Récupérer les commandes payées du restaurant
  let query = supabase
    .from('commandes')
    .select('id, total, date_commande')
    .eq('resto_id', restoId)
    .eq('statut', 'paye');
  
  if (startDate) {
    query = query.gte('date_commande', startDate.toISOString());
  }
  
  const { data: commandes, error: commandesError } = await query;
  
  if (commandesError) {
    return res.status(500).json({ error: commandesError.message });
  }
  
  // Calcul du CA total
  const caTotal = commandes.reduce((sum, cmd) => sum + (cmd.total || 0), 0);
  const nbCommandes = commandes.length;
  const panierMoyen = nbCommandes > 0 ? caTotal / nbCommandes : 0;
  
  // 2. Récupérer les détails des commandes (les plats vendus)
  if (commandes.length === 0) {
    return res.json({
      caTotal: 0,
      nbCommandes: 0,
      panierMoyen: 0,
      topPlats: [],
      repartitionParCategorie: {},
      evolutionParJour: []
    });
  }
  
  const commandeIds = commandes.map(c => c.id);
  
  const { data: details, error: detailsError } = await supabase
    .from('commande_details')
    .select('nom_plat, quantite, prix_unitaire, commande_id')
    .in('commande_id', commandeIds);
  
  if (detailsError) {
    return res.status(500).json({ error: detailsError.message });
  }
  
  // 3. Compter les ventes par plat
  const ventesParPlat = {};
  details.forEach(detail => {
    if (ventesParPlat[detail.nom_plat]) {
      ventesParPlat[detail.nom_plat] += detail.quantite;
    } else {
      ventesParPlat[detail.nom_plat] = detail.quantite;
    }
  });
  
  const topPlats = Object.entries(ventesParPlat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nom, quantite], index) => ({ 
      rank: index + 1, 
      nom, 
      quantite,
      chiffre: details
        .filter(d => d.nom_plat === nom)
        .reduce((sum, d) => sum + (d.prix_unitaire * d.quantite), 0)
    }));
  
  // 4. Répartition par catégorie (besoin des catégories depuis la table menus)
  const { data: menus } = await supabase
    .from('menus')
    .select('nom_plat, categorie')
    .eq('resto_id', restoId);
  
  const categorieParPlat = {};
  if (menus) {
    menus.forEach(m => {
      categorieParPlat[m.nom_plat] = m.categorie || 'Autre';
    });
  }
  
  const repartitionParCategorie = {};
  details.forEach(detail => {
    const cat = categorieParPlat[detail.nom_plat] || 'Autre';
    if (repartitionParCategorie[cat]) {
      repartitionParCategorie[cat] += detail.quantite;
    } else {
      repartitionParCategorie[cat] = detail.quantite;
    }
  });
  
  // 5. Évolution par jour (pour le graphique)
  const evolutionParJour = {};
  commandes.forEach(cmd => {
    const date = new Date(cmd.date_commande).toLocaleDateString('fr-FR');
    if (evolutionParJour[date]) {
      evolutionParJour[date] += cmd.total;
    } else {
      evolutionParJour[date] = cmd.total;
    }
  });
  
  const evolution = Object.entries(evolutionParJour)
    .sort((a, b) => new Date(a[0]) - new Date(b[0]))
    .map(([date, total]) => ({ date, total }));
  
  res.json({
    caTotal,
    nbCommandes,
    panierMoyen,
    topPlats,
    repartitionParCategorie,
    evolution,
    periode
  });
});

// ===== GESTION TABLES =====

app.get('/api/tables/:restoId', async (req, res) => {
  const { restoId } = req.params;
  
  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('resto_id', restoId)
    .order('numero_table');
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tables', async (req, res) => {
  const { restoId, numeroTable } = req.body;
  
  const { data, error } = await supabase
    .from('tables')
    .insert({ resto_id: restoId, numero_table: numeroTable })
    .select();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.delete('/api/tables/:id', async (req, res) => {
  const { id } = req.params;
  
  const { error } = await supabase
    .from('tables')
    .delete()
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/generate-qr/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `https://restapp-a8ac.onrender.com/menu.html?resto=${restoId}&table=${tableId}`;
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
    </body>
    </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ===== PHOTOS =====

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload-plat-photo/:platId', upload.single('photo'), async (req, res) => {
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

app.delete('/api/delete-photo/:platId', async (req, res) => {
  const { platId } = req.params;
  
  const { data: plat } = await supabase.from('menus').select('photo_url').eq('id', platId).single();
  
  if (plat?.photo_url) {
    const path = plat.photo_url.split('/').slice(-2).join('/');
    await supabase.storage.from('plat-photos').remove([path]);
  }
  
  await supabase.from('menus').update({ photo_url: null }).eq('id', platId);
  res.json({ success: true });
});

// WebSockets
io.on('connection', (socket) => {
  console.log('🟢 Client connecté');
  socket.on('join_resto', (restoId) => {
    socket.join(`resto_${restoId}`);
  });
});

server.listen(3001, '0.0.0.0', () => {
  console.log('🚀 Serveur sur http://localhost:3001');
});