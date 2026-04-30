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
        return res.status(403).json({ error: 'Accès interdit' });
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
  
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*, restaurants(*)')
    .eq('email', email)
    .single();
  
  if (error || !profile) {
    return res.status(401).json({ error: 'Email non reconnu' });
  }
  
  if (role && profile.role !== role) {
    return res.status(401).json({ error: `Accès non autorisé. Vous êtes ${profile.role}, pas ${role}.` });
  }
  
  const token = jwt.sign(
    { 
      id: profile.id, 
      email: profile.email, 
      resto_id: profile.resto_id,
      restaurant_name: profile.restaurants?.nom,
      slug: profile.restaurants?.slug,
      role: profile.role 
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({ success: true, token, user: profile, restaurant: profile.restaurants });
});

app.post('/api/auth/verify', authMiddleware, async (req, res) => {
  res.json({ success: true, user: req.user });
});

// ===== INSCRIPTION NOUVEAU RESTAURANT =====
app.post('/api/register', async (req, res) => {
  const { email, nomRestaurant, telephone, adresse } = req.body;
  
  // Vérifier si l'email existe déjà
  const { data: existingUser } = await supabase
    .from('profiles')
    .select('email')
    .eq('email', email)
    .single();
  
  if (existingUser) {
    return res.status(400).json({ error: 'Cet email est déjà utilisé' });
  }
  
  // Créer un slug unique avec un timestamp
  const baseSlug = nomRestaurant.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  
  const timestamp = Date.now();
  const slug = `${baseSlug}-${timestamp}`;
  
  // Créer le restaurant
  const { data: restaurant, error: restoError } = await supabase
    .from('restaurants')
    .insert({ 
      nom: nomRestaurant, 
      slug: slug, 
      telephone: telephone || null, 
      adresse: adresse || null, 
      actif: true 
    })
    .select()
    .single();
  
  if (restoError) {
    console.error('Erreur création restaurant:', restoError);
    return res.status(500).json({ error: 'Erreur lors de la création du restaurant: ' + restoError.message });
  }
  
  // Créer le profil gérant
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .insert({ 
      email: email, 
      resto_id: restaurant.id, 
      nom: nomRestaurant,
      role: 'gerant' 
    })
    .select()
    .single();
  
  if (profileError) {
    console.error('Erreur création profil:', profileError);
    // Nettoyer le restaurant créé
    await supabase.from('restaurants').delete().eq('id', restaurant.id);
    return res.status(500).json({ error: 'Erreur lors de la création du compte: ' + profileError.message });
  }
  
  // Créer les tables par défaut (1 à 10)
  const tables = [];
  for (let i = 1; i <= 10; i++) {
    tables.push({ resto_id: restaurant.id, numero_table: i });
  }
  await supabase.from('tables').insert(tables);
  
  // Créer des plats par défaut
  const platsParDefaut = [
    { resto_id: restaurant.id, nom_plat: 'Yassa Poulet', prix: 2500, categorie: 'Plat', disponible: true, description: 'Poulet mariné aux oignons et citron' },
    { resto_id: restaurant.id, nom_plat: 'Thieboudienne', prix: 3000, categorie: 'Plat', disponible: true, description: 'Riz au poisson et légumes' },
    { resto_id: restaurant.id, nom_plat: 'Mafé', prix: 2800, categorie: 'Plat', disponible: true, description: 'Sauce arachide et viande' },
    { resto_id: restaurant.id, nom_plat: 'Jus de Bissap', prix: 500, categorie: 'Boisson', disponible: true, description: 'Jus d\'hibiscus' },
    { resto_id: restaurant.id, nom_plat: 'Ngata', prix: 1500, categorie: 'Dessert', disponible: true, description: 'Beignet sénégalais' }
  ];
  await supabase.from('menus').insert(platsParDefaut);
  
  // Générer le token
  const token = jwt.sign(
    { 
      id: profile.id, 
      email: email, 
      resto_id: restaurant.id, 
      restaurant_name: restaurant.nom, 
      slug: restaurant.slug, 
      role: 'gerant' 
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({ 
    success: true, 
    token, 
    user: profile, 
    restaurant 
  });
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

// ROUTE COMMANDE AVEC NOM DU CLIENT
app.post('/api/commande', async (req, res) => {
  const { restoId, tableId, clientName, items, total } = req.body;
  
  const { data: commande, error: commandeError } = await supabase
    .from('commandes')
    .insert({ 
      resto_id: restoId, 
      table_id: tableId, 
      client_nom: clientName || 'Anonyme',
      total: total 
    })
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
    client_name: clientName || 'Anonyme',
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

app.get('/api/qrcode/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  
  try {
    const qrImage = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    res.json({ success: true, qr: qrImage, url });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/qrcode-image/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  
  try {
    const qrImage = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    const base64 = qrImage.replace(/^data:image\/png;base64,/, '');
    const imgBuffer = Buffer.from(base64, 'base64');
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(imgBuffer);
  } catch (error) {
    res.status(500).send('Erreur génération QR code');
  }
});

app.get('/api/generate-qr/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  const qrImage = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  
  const { data: resto } = await supabase.from('restaurants').select('nom').eq('id', restoId).single();
  const restoName = resto?.nom || 'RESTAURANT';
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>QR Code - ${restoName}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: 'Segoe UI', Arial, sans-serif; 
          text-align: center; 
          padding: 50px; 
          background: #f5f5f5;
        }
        .container {
          background: white;
          max-width: 400px;
          margin: 0 auto;
          padding: 40px;
          border-radius: 32px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        img { width: 250px; height: 250px; margin: 20px 0; }
        .restaurant-name { font-size: 24px; font-weight: bold; color: #1A1A2E; }
        .restaurant-name span { color: #C6A43F; }
        .table-number { font-size: 48px; color: #C6A43F; margin: 20px 0; font-weight: bold; }
        .instruction { color: #666; margin-top: 20px; font-size: 14px; }
        @media print { body { padding: 0; background: white; } .container { box-shadow: none; } .no-print { display: none; } }
        .print-btn { background: #C6A43F; border: none; padding: 10px 20px; border-radius: 40px; font-weight: bold; cursor: pointer; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="restaurant-name">🍽️ <span>${restoName}</span></div>
        <div class="table-number">TABLE ${tableId}</div>
        <img src="${qrImage}" alt="QR Code">
        <div class="instruction">📱 Scannez ce code pour accéder au menu</div>
        <button class="print-btn no-print" onclick="window.print()">🖨️ Imprimer</button>
      </div>
    </body>
    </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
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
    client_nom: cmd.client_nom || 'Anonyme',
    statut: cmd.statut,
    total: cmd.total,
    date_commande: cmd.date_commande,
    details: cmd.commande_details || []
  }));
  
  res.json(result);
});

// ===== ROUTES ADMIN =====
app.post('/api/admin/plat', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId, nom_plat, prix, categorie, disponible, description } = req.body;
  const finalRestoId = restoId || req.user.resto_id;
  
  const { data, error } = await supabase
    .from('menus')
    .insert({ resto_id: finalRestoId, nom_plat, prix, categorie, disponible, description })
    .select();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.put('/api/admin/plat/:id/disponible', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { disponible } = req.body;
  
  const { error } = await supabase
    .from('menus')
    .update({ disponible })
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/admin/plat/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  
  const { error } = await supabase
    .from('menus')
    .delete()
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/admin/menu/:restoId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId } = req.params;
  const targetRestoId = restoId || req.user.resto_id;
  
  const { data, error } = await supabase
    .from('menus')
    .select('*')
    .eq('resto_id', targetRestoId)
    .order('id', { ascending: true });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== ROUTES STATISTIQUES =====
app.get('/api/stats/:restoId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId } = req.params;
  const targetRestoId = restoId || req.user.resto_id;
  const { periode } = req.query;
  
  let startDate = null;
  const now = new Date();
  
  if (periode === 'day') startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (periode === 'week') startDate = new Date(now.setDate(now.getDate() - 7));
  else if (periode === 'month') startDate = new Date(now.setMonth(now.getMonth() - 1));
  
  let query = supabase
    .from('commandes')
    .select('id, total, date_commande')
    .eq('resto_id', targetRestoId)
    .eq('statut', 'paye');
  
  if (startDate) query = query.gte('date_commande', startDate.toISOString());
  
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
      ventesParPlat[detail.nom_plat] = (ventesParPlat[detail.nom_plat] || 0) + detail.quantite;
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

// ===== ROUTES TABLES =====
app.get('/api/tables/:restoId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId } = req.params;
  const targetRestoId = restoId || req.user.resto_id;
  
  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('resto_id', targetRestoId)
    .order('numero_table');
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tables', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId, numeroTable } = req.body;
  const targetRestoId = restoId || req.user.resto_id;
  
  const { data, error } = await supabase
    .from('tables')
    .insert({ resto_id: targetRestoId, numero_table: numeroTable })
    .select();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.delete('/api/tables/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  
  const { error } = await supabase
    .from('tables')
    .delete()
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ===== ROUTES PHOTOS =====
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload-plat-photo/:platId', checkRole(['gerant', 'superadmin']), upload.single('photo'), async (req, res) => {
  const { platId } = req.params;
  const file = req.file;
  
  if (!file) return res.status(400).json({ error: 'Aucune photo' });
  
  const fileName = `plat_${platId}_${Date.now()}.jpg`;
  const filePath = `plats/${fileName}`;
  
  const { error } = await supabase.storage
    .from('plat-photos')
    .upload(filePath, file.buffer, { contentType: file.mimetype });
  
  if (error) return res.status(500).json({ error: error.message });
  
  const { data: urlData } = supabase.storage.from('plat-photos').getPublicUrl(filePath);
  await supabase.from('menus').update({ photo_url: urlData.publicUrl }).eq('id', platId);
  
  res.json({ success: true, photoUrl: urlData.publicUrl });
});

app.delete('/api/delete-photo/:platId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { platId } = req.params;
  
  const { data: plat } = await supabase.from('menus').select('photo_url').eq('id', platId).single();
  
  if (plat?.photo_url) {
    const path = plat.photo_url.split('/').slice(-2).join('/');
    await supabase.storage.from('plat-photos').remove([path]);
  }
  
  await supabase.from('menus').update({ photo_url: null }).eq('id', platId);
  res.json({ success: true });
});

// Ajouter un employé (version avec lien unique)
app.post('/api/admin/employe', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { nom, prenom, role } = req.body;
  const restoId = req.user.resto_id;
  
  if (!nom || !role) {
    return res.status(400).json({ error: 'Nom et rôle requis' });
  }
  
  // Générer un token unique
  const tokenUnique = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const lienUnique = `${PUBLIC_URL}/magic.html?token=${tokenUnique}`;
  
  // Créer l'employé avec token
  const { data, error } = await supabase
    .from('profiles')
    .insert({ 
      nom: nom,
      prenom: prenom || '',
      resto_id: restoId, 
      role: role,
      token_unique: tokenUnique,
      lien_unique: lienUnique,
      email: `${tokenUnique}@magic.resto`
    })
    .select();
  
  if (error) return res.status(500).json({ error: error.message });
  
  const roleText = role === 'cuisinier' ? 'Cuisinier' : 'Serveur';
  const nomComplet = `${prenom} ${nom}`.trim();
  
  // Retourner le lien directement
  res.json({ 
    success: true, 
    employe: data[0],
    lien: lienUnique,
    nom: nomComplet,
    role: roleText
  });
});

// Modifier le rôle d'un employé
app.put('/api/admin/employe/:id/role', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  
  if (!role || !['cuisinier', 'serveur'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  
  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Supprimer un employé (DELETE)
app.delete('/api/admin/employe/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const restoId = req.user.resto_id;
  
  console.log('Tentative suppression employé - ID:', id, 'Resto ID:', restoId);
  
  // Vérifier que l'employé existe et appartient au restaurant
  const { data: employe, error: checkError } = await supabase
    .from('profiles')
    .select('id, resto_id')
    .eq('id', id)
    .single();
  
  if (checkError) {
    console.error('Erreur recherche employé:', checkError);
    return res.status(404).json({ error: 'Employé non trouvé' });
  }
  
  if (!employe) {
    return res.status(404).json({ error: 'Employé non trouvé' });
  }
  
  if (employe.resto_id !== restoId) {
    console.error('Non autorisé - resto_id ne correspond pas');
    return res.status(403).json({ error: 'Non autorisé' });
  }
  
  // Supprimer l'employé
  const { error } = await supabase
    .from('profiles')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Erreur suppression:', error);
    return res.status(500).json({ error: error.message });
  }
  
  console.log('Employé supprimé avec succès, ID:', id);
  res.json({ success: true });
});

// ===== ROUTES GESTION DES EMPLOYÉS =====

// Lister les employés (GET)
app.get('/api/admin/employes', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const restoId = req.user.resto_id;
  
  const { data, error } = await supabase
    .from('profiles')
    .select('id, nom, prenom, role, token_unique, lien_unique, created_at')
    .eq('resto_id', restoId)
    .neq('role', 'gerant')
    .neq('role', 'superadmin')
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Erreur liste employés:', error);
    return res.status(500).json({ error: error.message });
  }
  
  res.json(data || []);
});

// Ajouter un employé (POST)
app.post('/api/admin/employe', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { nom, prenom, role } = req.body;
  const restoId = req.user.resto_id;
  
  if (!nom || !role) {
    return res.status(400).json({ error: 'Nom et rôle requis' });
  }
  
  // Vérifier si un employé avec ce nom existe déjà
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('resto_id', restoId)
    .eq('nom', nom)
    .eq('prenom', prenom || '')
    .single();
  
  if (existing) {
    return res.status(400).json({ error: 'Cet employé existe déjà' });
  }
  
  // Générer un token unique
  const tokenUnique = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const lienUnique = `${PUBLIC_URL}/magic.html?token=${tokenUnique}`;
  
  // Créer l'employé
  const { data, error } = await supabase
    .from('profiles')
    .insert({ 
      nom: nom.trim(),
      prenom: prenom ? prenom.trim() : '',
      resto_id: restoId, 
      role: role,
      token_unique: tokenUnique,
      lien_unique: lienUnique,
      email: `${tokenUnique}@temp.resto`
    })
    .select();
  
  if (error) {
    console.error('Erreur création employé:', error);
    return res.status(500).json({ error: error.message });
  }
  
  const roleText = role === 'cuisinier' ? 'Cuisinier' : 'Serveur';
  const nomComplet = `${prenom ? prenom + ' ' : ''}${nom}`.trim();
  
  res.json({ 
    success: true, 
    employe: data[0],
    lien: lienUnique,
    nom: nomComplet,
    role: roleText
  });
});

// Supprimer un employé (DELETE)
app.delete('/api/admin/employe/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const restoId = req.user.resto_id;
  
  console.log('=== SUPPRESSION ===');
  console.log('ID:', id);
  console.log('Resto ID:', restoId);
  
  try {
    // Vérifier que l'employé existe et appartient au restaurant
    const { data: employe, error: findError } = await supabase
      .from('profiles')
      .select('id, resto_id')
      .eq('id', id)
      .single();
    
    if (findError || !employe) {
      console.log('Employé non trouvé');
      return res.status(404).json({ error: 'Employé non trouvé' });
    }
    
    if (employe.resto_id !== restoId) {
      console.log('Non autorisé');
      return res.status(403).json({ error: 'Non autorisé' });
    }
    
    // Supprimer l'employé
    const { error: deleteError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      console.log('Erreur suppression:', deleteError);
      return res.status(500).json({ error: deleteError.message });
    }
    
    console.log('✅ Suppression réussie');
    res.json({ success: true });
    
  } catch (error) {
    console.error('Exception:', error);
    res.status(500).json({ error: error.message });
  }
});

// Modifier le rôle d'un employé (PUT)
app.put('/api/admin/employe/:id/role', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  
  if (!role || !['cuisinier', 'serveur'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  
  const { error } = await supabase
    .from('profiles')
    .update({ role: role })
    .eq('id', id);
  
  if (error) {
    console.error('Erreur modification rôle:', error);
    return res.status(500).json({ error: error.message });
  }
  
  res.json({ success: true });
});

// ===== CONNEXION MAGIQUE PAR LIEN UNIQUE =====
app.get('/api/auth/magic/:token', async (req, res) => {
  const { token } = req.params;
  
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('token_unique', token)
    .single();
  
  if (error || !profile) {
    return res.status(401).json({ error: 'Lien invalide ou expiré' });
  }
  
  const jwtToken = jwt.sign(
    { 
      id: profile.id, 
      email: profile.email || `${profile.token_unique}@magic.resto`,
      prenom: profile.prenom,
      nom: profile.nom,
      resto_id: profile.resto_id, 
      role: profile.role 
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  
  res.json({ success: true, token: jwtToken, user: profile });
});

// ===== WEBSOCKETS =====
io.on('connection', (socket) => {
  console.log('🟢 Client connecté');
  socket.on('join_resto', (restoId) => {
    socket.join(`resto_${restoId}`);
  });
});

// ===== SUIVI COMMANDE =====
app.get('/api/commande/suivi/:id', async (req, res) => {
  const { id } = req.params;
  
  const { data: commande, error: cmdError } = await supabase
    .from('commandes')
    .select('*')
    .eq('id', id)
    .single();
  
  if (cmdError || !commande) return res.status(404).json({ error: 'Commande non trouvée' });
  
  const { data: details, error: detError } = await supabase
    .from('commande_details')
    .select('nom_plat, quantite, prix_unitaire')
    .eq('commande_id', id);
  
  res.json({ id: commande.id, statut: commande.statut, total: commande.total, date_commande: commande.date_commande, details: details || [] });
});

// ===== SUPER ADMIN : Liste tous les restaurants =====
app.get('/api/superadmin/restaurants', checkRole(['superadmin']), async (req, res) => {
  const { data, error } = await supabase.from('restaurants').select('*, profiles(count)');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== LANCEMENT =====
server.listen(3001, '0.0.0.0', () => {
  console.log('🚀 Serveur sur http://localhost:3001');
});