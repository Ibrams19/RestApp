// ==================== server.js - VERSION COMPLÈTE PROFESSIONNELLE ====================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ==================== CONFIGURATION ====================
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static('frontend/client'));

const supabaseUrl = 'https://hgteqscrpglafdjmhnuc.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhndGVxc2NycGdsYWZkam1obnVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MTE3MjEsImV4cCI6MjA5Mjk4NzcyMX0.CjLEEFyk91yc3-QSmzYoyRNvGfsbeQtC6kO5sCe2NPQ';

const supabase = createClient(supabaseUrl, supabaseKey);

const JWT_SECRET = process.env.JWT_SECRET || 'resto-secret-key-2024-very-strong-change-in-production';
const PUBLIC_URL = 'https://restapp-a8ac.onrender.com';
const SALT_ROUNDS = 10;

// ==================== MIDDLEWARES ====================

// 1. Authentification JWT
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé - Token manquant' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};

// 2. Vérification des rôles
const checkRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user?.role || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'access_denied', message: 'Accès interdit - Rôle insuffisant' });
    }
    next();
  };
};

// 3. Middleware Abonnement Renforcé (avec vérification end_date)
const checkSubscription = async (req, res, next) => {
  if (req.user?.role === 'superadmin') return next();

  const restoId = req.user?.resto_id;
  if (!restoId) {
    return res.status(403).json({ error: 'restaurant_not_found', message: 'Restaurant non identifié' });
  }

  try {
    // Récupérer le restaurant et la dernière transaction
    const { data: restaurant, error } = await supabase
      .from('restaurants')
      .select('id, nom, subscription_status, trial_ends_at, subscription_ends_at')
      .eq('id', restoId)
      .single();

    if (error || !restaurant) {
      return res.status(403).json({ error: 'restaurant_not_found', message: 'Restaurant introuvable' });
    }

    const now = new Date();
    let isValid = false;

    // Vérifier d'abord la dernière transaction payée
    const { data: lastTransaction } = await supabase
      .from('transactions')
      .select('end_date, status')
      .eq('resto_id', restoId)
      .eq('status', 'paid')
      .order('end_date', { ascending: false })
      .limit(1)
      .single();

    // Si une transaction récente existe, l'utiliser comme source de vérité
    if (lastTransaction && lastTransaction.end_date) {
      const transactionEnd = new Date(lastTransaction.end_date);
      isValid = now <= transactionEnd;
      
      // Mettre à jour le statut du restaurant si nécessaire
      if (isValid && restaurant.subscription_status !== 'active') {
        await supabase
          .from('restaurants')
          .update({ 
            subscription_status: 'active',
            subscription_ends_at: lastTransaction.end_date
          })
          .eq('id', restoId);
      }
    } else {
      // Fallback sur les dates du restaurant
      switch (restaurant.subscription_status) {
        case 'active':
          if (restaurant.subscription_ends_at) isValid = now <= new Date(restaurant.subscription_ends_at);
          break;
        case 'trial':
          if (restaurant.trial_ends_at) isValid = now <= new Date(restaurant.trial_ends_at);
          break;
        case 'expired':
        case 'suspended':
          isValid = false;
          break;
        default:
          isValid = false;
      }
    }

    // Mise à jour automatique si expiré
    if (!isValid && ['trial', 'active'].includes(restaurant.subscription_status)) {
      await supabase
        .from('restaurants')
        .update({ subscription_status: 'expired' })
        .eq('id', restoId);
    }

    if (!isValid) {
      return res.status(403).json({
        error: "subscription_expired",
        message: "Votre abonnement a expiré. Veuillez le renouveler pour continuer.",
        redirect: "/subscription-renew.html",
        restaurantName: restaurant.nom,
        status: restaurant.subscription_status
      });
    }

    req.restaurant = restaurant;
    next();

  } catch (err) {
    console.error("Erreur checkSubscription:", err);
    return res.status(500).json({ error: 'server_error', message: 'Erreur interne lors de la vérification abonnement' });
  }
};

// ==================== APPLICATION DES MIDDLEWARES ====================

app.use('/api/admin/*', authMiddleware, checkSubscription);
app.use('/api/stats/*', authMiddleware, checkSubscription);
app.use('/api/tables/*', authMiddleware, checkSubscription);
app.use('/api/restaurant/*', authMiddleware, checkSubscription);
app.use('/api/superadmin/*', authMiddleware, checkRole(['superadmin']));

// Routes employées (gestion par gérant)
app.use('/api/admin/employes', authMiddleware, checkRole(['gerant', 'superadmin']));
app.use('/api/admin/employe', authMiddleware, checkRole(['gerant', 'superadmin']));

// ==================== AUTHENTIFICATION ====================

app.post('/api/auth/login', async (req, res) => {
  const { email, motDePasse } = req.body;
  if (!email || !motDePasse) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*, restaurants(*)')
    .eq('email', email)
    .single();

  if (error || !profile) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  if (!profile.mot_de_passe) return res.status(401).json({ error: 'first_login', message: 'Utilisez votre lien magique.' });

  const isValid = await bcrypt.compare(motDePasse, profile.mot_de_passe);
  if (!isValid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

  // Vérification abonnement au login
  if (profile.role !== 'superadmin' && profile.resto_id) {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('subscription_status, trial_ends_at, subscription_ends_at, nom')
      .eq('id', profile.resto_id)
      .single();

    if (restaurant && !isSubscriptionValid(restaurant)) {
      return res.status(403).json({
        error: "subscription_expired",
        message: "Votre période d'essai ou abonnement a expiré.",
        redirect: "/subscription-renew.html",
        restaurantName: restaurant.nom
      });
    }
  }

  const token = jwt.sign(
    { 
      id: profile.id, 
      email: profile.email, 
      resto_id: profile.resto_id, 
      restaurant_name: profile.restaurants?.nom, 
      role: profile.role 
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ success: true, token, user: profile, restaurant: profile.restaurants });
});

function isSubscriptionValid(restaurant) {
  if (!restaurant) return false;
  const now = new Date();

  if (restaurant.subscription_status === 'active' && restaurant.subscription_ends_at) {
    return now <= new Date(restaurant.subscription_ends_at);
  }
  if (restaurant.subscription_status === 'trial' && restaurant.trial_ends_at) {
    return now <= new Date(restaurant.trial_ends_at);
  }
  return false;
}

// Magic Link + Set Password + Forgot/Reset Password
app.get('/api/auth/magic/:token', async (req, res) => {
  const { token } = req.params;
  const { data: profile } = await supabase.from('profiles').select('*').eq('token_unique', token).single();
  if (!profile) return res.redirect(`${PUBLIC_URL}/set-password.html?error=invalid`);
  res.redirect(`${PUBLIC_URL}/set-password.html?token=${token}&email=${encodeURIComponent(profile.email)}&role=${profile.role}&resto_id=${profile.resto_id}`);
});

app.post('/api/auth/set-password', async (req, res) => {
  const { token, email, motDePasse, role, restoId } = req.body;
  if (!motDePasse || motDePasse.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });

  const hashedPassword = await bcrypt.hash(motDePasse, SALT_ROUNDS);
  const { data, error } = await supabase
    .from('profiles')
    .update({ mot_de_passe: hashedPassword, first_login: false, reset_token: null, reset_token_expires: null })
    .eq('token_unique', token)
    .select();

  if (error) return res.status(500).json({ error: error.message });

  const jwtToken = jwt.sign({ id: data[0].id, email, resto_id: restoId, role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token: jwtToken, user: data[0] });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const { data: profile } = await supabase.from('profiles').select('*').eq('email', email).single();
  if (!profile) return res.status(404).json({ error: 'Email non trouvé' });

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenExpires = new Date(Date.now() + 3600000);

  await supabase.from('profiles').update({ reset_token: resetToken, reset_token_expires: resetTokenExpires }).eq('id', profile.id);

  const resetUrl = `${PUBLIC_URL}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(email)}`;
  res.json({ success: true, message: 'Lien de réinitialisation envoyé', resetUrl });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, email, motDePasse } = req.body;
  if (!motDePasse || motDePasse.length < 8) return res.status(400).json({ error: 'Minimum 8 caractères' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .eq('reset_token', token)
    .single();

  if (!profile || new Date() > new Date(profile.reset_token_expires)) {
    return res.status(400).json({ error: 'Lien invalide ou expiré' });
  }

  const hashedPassword = await bcrypt.hash(motDePasse, SALT_ROUNDS);
  await supabase.from('profiles').update({ mot_de_passe: hashedPassword, reset_token: null, reset_token_expires: null }).eq('id', profile.id);

  const jwtToken = jwt.sign({ id: profile.id, email, resto_id: profile.resto_id, role: profile.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token: jwtToken });
});

// ==================== INSCRIPTION RESTAURANT ====================
app.post('/api/register', async (req, res) => {
  const { email, motDePasse, nomRestaurant, telephone, adresse } = req.body;
  if (!email || !motDePasse || !nomRestaurant) return res.status(400).json({ error: 'Champs requis' });
  if (motDePasse.length < 8) return res.status(400).json({ error: 'Mot de passe minimum 8 caractères' });

  const { data: existingUser } = await supabase.from('profiles').select('email').eq('email', email).single();
  if (existingUser) return res.status(400).json({ error: 'Email déjà utilisé' });

  const hashedPassword = await bcrypt.hash(motDePasse, SALT_ROUNDS);
  const baseSlug = nomRestaurant.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const slug = `${baseSlug}-${Date.now()}`;
  // Au lieu de 14 jours, mettre 1 minute pour le test
  const trialEndsAt = new Date(Date.now() + 60 * 1000); // 1 minute
  // const trialEndsAt = new Date(Date.now() + 14 * 86400000); // 14 jours (commenté)

  const { data: restaurant, error: restoError } = await supabase
    .from('restaurants')
    .insert({ 
      nom: nomRestaurant, 
      slug, 
      telephone: telephone || null, 
      adresse: adresse || null, 
      actif: true, 
      subscription_status: 'trial', 
      trial_ends_at: trialEndsAt 
    })
    .select()
    .single();

  if (restoError) return res.status(500).json({ error: restoError.message });

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .insert({ 
      email, 
      resto_id: restaurant.id, 
      nom: nomRestaurant, 
      mot_de_passe: hashedPassword, 
      role: 'gerant', 
      first_login: false 
    })
    .select()
    .single();

  if (profileError) {
    await supabase.from('restaurants').delete().eq('id', restaurant.id);
    return res.status(500).json({ error: profileError.message });
  }

  // Tables par défaut
  for (let i = 1; i <= 10; i++) {
    await supabase.from('tables').insert({ resto_id: restaurant.id, numero_table: i });
  }

  // Plats par défaut
  const platsParDefaut = [
    { resto_id: restaurant.id, nom_plat: 'Yassa Poulet', prix: 2500, categorie: 'Plat', disponible: true },
    { resto_id: restaurant.id, nom_plat: 'Thieboudienne', prix: 3000, categorie: 'Plat', disponible: true },
    { resto_id: restaurant.id, nom_plat: 'Mafé', prix: 2800, categorie: 'Plat', disponible: true },
    { resto_id: restaurant.id, nom_plat: 'Jus de Bissap', prix: 500, categorie: 'Boisson', disponible: true },
    { resto_id: restaurant.id, nom_plat: 'Ngata', prix: 1500, categorie: 'Dessert', disponible: true }
  ];
  await supabase.from('menus').insert(platsParDefaut);

  const token = jwt.sign(
    { id: profile.id, email, resto_id: restaurant.id, restaurant_name: restaurant.nom, role: 'gerant' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ success: true, token, user: profile, restaurant, trial_days: 14 });
});

// ==================== ROUTES CLIENT ====================
app.get('/api/menu/:restoId', async (req, res) => {
  const { restoId } = req.params;
  const { data, error } = await supabase.from('menus').select('*').eq('resto_id', restoId).eq('disponible', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/commande', async (req, res) => {
  const { restoId, tableId, clientName, items, total } = req.body;
  const { data: commande, error: commandeError } = await supabase
    .from('commandes')
    .insert({ resto_id: restoId, table_id: tableId, client_nom: clientName || 'Anonyme', total })
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
  const { error } = await supabase.from('commandes').update({ statut }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  io.to(`resto_${restoId}`).emit('statut_change', { commande_id: id, statut });
  res.json({ success: true });
});

app.get('/api/commandes/:restoId', async (req, res) => {
  const { restoId } = req.params;
  const { data: commandes, error } = await supabase
    .from('commandes')
    .select(`*, tables(numero_table), commande_details(quantite, prix_unitaire, nom_plat)`)
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

app.get('/api/commande/suivi/:id', async (req, res) => {
  const { id } = req.params;
  const { data: commande } = await supabase.from('commandes').select('*').eq('id', id).single();
  if (!commande) return res.status(404).json({ error: 'Commande non trouvée' });

  const { data: details } = await supabase.from('commande_details').select('nom_plat, quantite, prix_unitaire').eq('commande_id', id);
  res.json({ id: commande.id, statut: commande.statut, total: commande.total, date_commande: commande.date_commande, details: details || [] });
});

// ==================== QR CODES ====================
app.get('/api/qrcode/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  const qrImage = await QRCode.toDataURL(url, { width: 200, margin: 1 });
  res.json({ success: true, qr: qrImage, url });
});

app.get('/api/generate-qr/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;
  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  const qrImage = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  const { data: resto } = await supabase.from('restaurants').select('nom').eq('id', restoId).single();
  const restoName = resto?.nom || 'RESTAURANT';

  res.send(`<!DOCTYPE html>
  <html><head><meta charset="UTF-8"><title>QR Code - ${restoName}</title>
  <style>body{font-family:Arial;text-align:center;padding:50px;background:#f5f5f5}.container{background:white;max-width:400px;margin:0 auto;padding:40px;border-radius:32px}img{width:250px;margin:20px 0}.restaurant-name{font-size:24px;font-weight:bold}.restaurant-name span{color:#C6A43F}.table-number{font-size:48px;color:#C6A43F;margin:20px 0}@media print{body{padding:0;background:white}.no-print{display:none}}.print-btn{background:#C6A43F;border:none;padding:10px 20px;border-radius:40px;cursor:pointer;margin-top:20px}</style></head>
  <body><div class="container"><div class="restaurant-name">🍽️ <span>${restoName}</span></div><div class="table-number">TABLE ${tableId}</div><img src="${qrImage}"><div class="instruction">📱 Scannez pour accéder au menu</div><button class="print-btn no-print" onclick="window.print()">🖨️ Imprimer</button></div></body></html>`);
});

// ==================== ROUTES ADMIN - GESTION PLATS ====================
app.post('/api/admin/plat', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId, nom_plat, prix, categorie, disponible, description } = req.body;
  const finalRestoId = restoId || req.user.resto_id;

  const { data, error } = await supabase.from('menus').insert({
    resto_id: finalRestoId,
    nom_plat,
    prix,
    categorie,
    disponible,
    description
  }).select();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.get('/api/admin/menu/:restoId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const targetRestoId = req.params.restoId || req.user.resto_id;
  const { data, error } = await supabase.from('menus').select('*').eq('resto_id', targetRestoId).order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/admin/plat/:id/disponible', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { disponible } = req.body;
  const { error } = await supabase.from('menus').update({ disponible }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/admin/plat/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('menus').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ==================== ROUTES STATISTIQUES ====================
app.get('/api/stats/:restoId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const targetRestoId = req.params.restoId || req.user.resto_id;
  const { periode } = req.query;

  let startDate = null;
  const now = new Date();
  if (periode === 'day') startDate = new Date(now.setHours(0, 0, 0, 0));
  else if (periode === 'week') startDate = new Date(now.setDate(now.getDate() - 7));
  else if (periode === 'month') startDate = new Date(now.setMonth(now.getMonth() - 1));

  let query = supabase.from('commandes').select('id, total').eq('resto_id', targetRestoId).eq('statut', 'paye');
  if (startDate) query = query.gte('date_commande', startDate.toISOString());

  const { data: commandes } = await query;

  const caTotal = commandes?.reduce((s, c) => s + (c.total || 0), 0) || 0;
  const nbCommandes = commandes?.length || 0;
  const panierMoyen = nbCommandes ? caTotal / nbCommandes : 0;

  const commandeIds = commandes?.map(c => c.id) || [];
  const { data: details } = await supabase.from('commande_details').select('nom_plat, quantite').in('commande_id', commandeIds);

  const ventesParPlat = {};
  details?.forEach(d => {
    ventesParPlat[d.nom_plat] = (ventesParPlat[d.nom_plat] || 0) + d.quantite;
  });

  const topPlats = Object.entries(ventesParPlat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nom, quantite]) => ({ nom, quantite }));

  res.json({ caTotal, nbCommandes, panierMoyen, topPlats });
});

// ==================== ROUTES TABLES ====================
app.get('/api/tables/:restoId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const targetRestoId = req.params.restoId || req.user.resto_id;
  const { data, error } = await supabase.from('tables').select('*').eq('resto_id', targetRestoId).order('numero_table');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tables', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId, numeroTable } = req.body;
  const targetRestoId = restoId || req.user.resto_id;
  const { data, error } = await supabase.from('tables').insert({ resto_id: targetRestoId, numero_table: numeroTable }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.delete('/api/tables/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('tables').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ==================== UPLOAD PHOTOS ====================
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload-plat-photo/:platId', checkRole(['gerant', 'superadmin']), upload.single('photo'), async (req, res) => {
  const { platId } = req.params;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Aucune photo envoyée' });

  const fileName = `plat_${platId}_${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('plat-photos').upload(`plats/${fileName}`, file.buffer, { contentType: file.mimetype });

  if (error) return res.status(500).json({ error: error.message });

  const { data: urlData } = supabase.storage.from('plat-photos').getPublicUrl(`plats/${fileName}`);
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

// ==================== GESTION EMPLOYÉS ====================
app.get('/api/admin/employes', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, nom, prenom, role, token_unique, lien_unique, created_at')
    .eq('resto_id', req.user.resto_id)
    .neq('role', 'gerant')
    .neq('role', 'superadmin')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/admin/employe', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { nom, prenom, role } = req.body;
  if (!nom || !role) return res.status(400).json({ error: 'Nom et rôle requis' });

  const tokenUnique = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const lienUnique = `${PUBLIC_URL}/magic.html?token=${tokenUnique}`;

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      nom: nom.trim(),
      prenom: prenom?.trim() || '',
      resto_id: req.user.resto_id,
      role,
      token_unique: tokenUnique,
      lien_unique: lienUnique,
      email: `${tokenUnique}@temp.resto`,
      first_login: true
    })
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    success: true,
    employe: data[0],
    lien: lienUnique,
    nom: `${prenom || ''} ${nom}`.trim(),
    role: role === 'cuisinier' ? 'Cuisinier' : 'Serveur'
  });
});

app.delete('/api/admin/employe/:id', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('profiles').delete().eq('id', id).eq('resto_id', req.user.resto_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ==================== ROUTES ABONNEMENT ====================
app.get('/api/restaurant/subscription', authMiddleware, async (req, res) => {
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('subscription_status, trial_ends_at, subscription_ends_at')
    .eq('id', req.user.resto_id)
    .single();

  if (!restaurant) return res.status(404).json({ error: 'Restaurant non trouvé' });

  const response = { status: restaurant.subscription_status };
  if (restaurant.subscription_status === 'trial') {
    const daysLeft = Math.ceil((new Date(restaurant.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24));
    response.days_left = Math.max(0, daysLeft);
    response.ends_at = restaurant.trial_ends_at;
  } else if (restaurant.subscription_status === 'active') {
    response.ends_at = restaurant.subscription_ends_at;
  }

  res.json(response);
});

// ==================== HISTORIQUE DES TRANSACTIONS ====================
app.get('/api/restaurant/transactions', authMiddleware, async (req, res) => {
  const restoId = req.user.resto_id;

  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('resto_id', restoId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

// ==================== SUPER ADMIN ====================
app.get('/api/superadmin/restaurants', checkRole(['superadmin']), async (req, res) => {
  const { data, error } = await supabase.from('restaurants').select('*, profiles(count)');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ==================== ROUTE DE PAIEMENT SIMULÉ ====================
app.post('/api/subscription/renew', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  const restoId = req.user.resto_id;
  const profileId = req.user.id;

  console.log('📢 Demande de paiement reçue pour resto:', restoId, 'plan:', plan);

  / Pour tester rapidement, remplacer les mois par des minutes
  const plans = {
    monthly: { amount: 25000, minutes: 1, name: 'Mensuel' },    // 1 minute
    quarterly: { amount: 60000, minutes: 3, name: 'Trimestriel' }, // 3 minutes
    yearly: { amount: 200000, minutes: 5, name: 'Annuel' }      // 5 minutes
  };


  if (!plan || !plans[plan]) {
    return res.status(400).json({ error: 'Plan invalide' });
  }

  const config = plans[plan];
  const startDate = new Date();
  const endDate = new Date();
  endDate.setMinutes(endDate.getMinutes() + config.minutes); // au lieu de setMonth
  try {
    // 1. Mettre à jour l'abonnement du restaurant directement
    const { error: updateError } = await supabase
      .from('restaurants')
      .update({
        subscription_status: 'active',
        subscription_ends_at: endDate.toISOString()
      })
      .eq('id', restoId);

    if (updateError) throw updateError;

    // 2. Enregistrer la transaction
    const transactionRef = `PAY_${restoId}_${Date.now()}`;
    await supabase
      .from('transactions')
      .insert({
        resto_id: restoId,
        transaction_ref: transactionRef,
        plan_type: plan,
        amount: config.amount,
        status: 'paid',
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        initiated_by: profileId,
        payment_date: new Date().toISOString()
      });

    console.log('✅ Abonnement activé pour resto', restoId, 'jusqu\'au', endDate);

    res.json({
      success: true,
      message: `✅ Abonnement ${config.name} activé avec succès ! Valable jusqu'au ${endDate.toLocaleDateString('fr-FR')}`,
      end_date: endDate
    });

  } catch (error) {
    console.error('Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subscription/initiate', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  const restoId = req.user.resto_id;
  const profileId = req.user.id;

  const plans = {
    monthly: { amount: 25000, months: 1, name: 'Mensuel' },
    quarterly: { amount: 60000, months: 3, name: 'Trimestriel' },
    yearly: { amount: 200000, months: 12, name: 'Annuel' }
  };

  const config = plans[plan];
  const startDate = new Date();
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + config.months);
  const transactionRef = `PAY_${restoId}_${Date.now()}`;

  const { data: transaction, error } = await supabase
    .from('transactions')
    .insert({
      resto_id: restoId,
      transaction_ref: transactionRef,
      plan_type: plan,
      amount: config.amount,
      status: 'pending',
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      initiated_by: profileId
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    success: true,
    transaction_id: transaction.id,
    amount: config.amount,
    message: `Demande de paiement de ${config.amount.toLocaleString()} FCFA créée`
  });
});

// ==================== WEBSOCKETS ====================
io.on('connection', (socket) => {
  console.log('🟢 Client connecté');
  socket.on('join_resto', (restoId) => socket.join(`resto_${restoId}`));
});

// ==================== LANCEMENT ====================
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log('✅ Système d\'abonnement renforcé activé');
});