// ==================== server.js - VERSION 7 ÉTOILES CORRIGÉE ====================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ==================== CONFIGURATION ====================
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));
app.use(express.static('frontend/client'));
app.use(morgan(':date[iso] :method :url :status :response-time ms - :remote-addr'));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!supabaseUrl || !supabaseKey || !JWT_SECRET) {
  console.error('❌ Variables d\'environnement manquantes : SUPABASE_URL, SUPABASE_KEY, JWT_SECRET');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://restapp-a8ac.onrender.com';
const SALT_ROUNDS = 12;

// ==================== RATE LIMITERS ====================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes. Ralentissez.' }
});

const commandLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Trop de commandes. Réessayez dans une minute.' }
});

// ==================== VALIDATION ====================
const VALID_TRANSITIONS = {
  'en_attente': ['cuisine'],
  'cuisine': ['pret'],
  'pret': ['servi'],
  'servi': ['paye']
};

const VALID_ROLES = ['gerant', 'serveur', 'superadmin'];
const VALID_CATEGORIES = ['Entrée', 'Plat', 'Dessert', 'Boisson', 'Accompagnement', 'Pâtisserie', 'Crêpe', 'Glace'];

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

function sanitizeString(str) {
  if (!str) return '';
  return String(str).trim().replace(/[<>]/g, '');
}

function isValidUUID(str) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

// ==================== FONCTION UTILITAIRE ====================
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

function logSecurity(level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...metadata
  };
  if (level === 'ERROR' || level === 'SECURITY') {
    console.error(JSON.stringify(logEntry));
  } else {
    console.log(JSON.stringify(logEntry));
  }
}

// ==================== MIDDLEWARES ====================
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    logSecurity('SECURITY', 'Tentative accès sans token', { ip: req.ip, path: req.path });
    return res.status(401).json({ 
      error: 'auth_required',
      message: 'Veuillez vous connecter pour accéder à cette page.',
      redirect: '/login.html'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    logSecurity('SECURITY', 'Token invalide', { ip: req.ip, path: req.path });
    return res.status(401).json({ 
      error: 'token_invalid',
      message: 'Votre session a expiré. Veuillez vous reconnecter.',
      redirect: '/login.html'
    });
  }
};

const checkRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user?.role || !allowedRoles.includes(req.user.role)) {
      logSecurity('SECURITY', 'Tentative accès rôle non autorisé', { 
        user: req.user?.email, 
        role: req.user?.role, 
        required: allowedRoles,
        path: req.path 
      });
      return res.status(403).json({ 
        error: 'access_denied',
        message: 'Vous n\'avez pas les droits pour effectuer cette action.',
        code: 'FORBIDDEN'
      });
    }
    next();
  };
};

const checkSubscription = async (req, res, next) => {
  if (req.user?.role === 'superadmin') return next();

  const restoId = req.user?.resto_id;
  if (!restoId) return next();

  try {
    const { data: restaurant, error } = await supabase
      .from('restaurants')
      .select('subscription_status, trial_ends_at, subscription_ends_at, nom')
      .eq('id', restoId)
      .single();

    if (error || !restaurant) return next();

    if (!isSubscriptionValid(restaurant)) {
      if (restaurant.subscription_status !== 'expired') {
        await supabase.from('restaurants').update({ subscription_status: 'expired' }).eq('id', restoId);
      }
      
      logSecurity('INFO', 'Accès bloqué - abonnement expiré', { restoId, restaurant: restaurant.nom });
      
      return res.status(403).json({
        error: 'subscription_expired',
        message: `L'abonnement de ${restaurant.nom} a expiré. Renouvelez-le pour continuer à utiliser le service.`,
        redirect: '/subscription-renew.html',
        restaurantName: restaurant.nom,
        code: 'SUBSCRIPTION_EXPIRED'
      });
    }

    next();
  } catch (err) {
    logSecurity('ERROR', 'Erreur vérification abonnement', { error: err.message, restoId });
    next();
  }
};

const verifyRestaurantAccess = async (req, res, next) => {
  const targetRestoId = req.params.restoId || req.body.restoId || req.query.restoId;
  
  if (req.user?.role === 'superadmin') return next();
  if (!targetRestoId) return next();
  if (req.user?.resto_id?.toString() === targetRestoId.toString()) return next();
  
  logSecurity('SECURITY', 'Tentative accès autre restaurant', {
    user: req.user?.email,
    userResto: req.user?.resto_id,
    targetResto: targetRestoId
  });
  
  return res.status(403).json({
    error: 'access_denied',
    message: 'Vous ne pouvez pas accéder aux données de ce restaurant.',
    code: 'WRONG_RESTAURANT'
  });
};

// ==================== APPLICATION MIDDLEWARES ====================
app.use('/api/', apiLimiter);
app.use('/api/admin/*', authMiddleware, checkSubscription, verifyRestaurantAccess);
app.use('/api/stats/*', authMiddleware, checkSubscription, verifyRestaurantAccess);
app.use('/api/tables/*', authMiddleware, checkSubscription, verifyRestaurantAccess);
app.use('/api/restaurant/*', authMiddleware, checkSubscription);
app.use('/api/superadmin/*', authMiddleware, checkRole(['superadmin']));
app.use('/api/employes/*', authMiddleware, checkSubscription, verifyRestaurantAccess);

// ==================== ROUTES PUBLIQUES ====================

// Login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, motDePasse } = req.body;
  
  if (!email || !motDePasse) {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Email et mot de passe sont requis.',
      code: 'MISSING_FIELDS'
    });
  }

  if (!validateEmail(email)) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Format d\'email invalide.',
      code: 'INVALID_EMAIL'
    });
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*, restaurants(*)')
    .eq('email', email)
    .single();

  if (error || !profile) {
    logSecurity('SECURITY', 'Tentative connexion email inconnu', { email });
    return res.status(401).json({ 
      error: 'invalid_credentials',
      message: 'Email ou mot de passe incorrect.',
      code: 'AUTH_FAILED'
    });
  }

  if (!profile.mot_de_passe) {
    return res.status(401).json({ 
      error: 'first_login',
      message: 'Première connexion. Utilisez votre lien d\'invitation.',
      code: 'NEEDS_SETUP'
    });
  }

  const isValid = await bcrypt.compare(motDePasse, profile.mot_de_passe);
  if (!isValid) {
    logSecurity('SECURITY', 'Mot de passe incorrect', { email });
    return res.status(401).json({ 
      error: 'invalid_credentials',
      message: 'Email ou mot de passe incorrect.',
      code: 'AUTH_FAILED'
    });
  }

  if (profile.role !== 'superadmin' && profile.resto_id) {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('subscription_status, trial_ends_at, subscription_ends_at, nom')
      .eq('id', profile.resto_id)
      .single();

    if (restaurant && !isSubscriptionValid(restaurant)) {
      return res.status(403).json({
        error: 'subscription_expired',
        message: `L'abonnement de ${restaurant.nom} a expiré. Veuillez le renouveler pour continuer.`,
        redirect: '/subscription-renew.html',
        restaurantName: restaurant.nom,
        code: 'SUBSCRIPTION_EXPIRED'
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

  logSecurity('INFO', 'Connexion réussie', { email, role: profile.role });

  res.json({ 
    success: true, 
    token, 
    user: {
      id: profile.id,
      email: profile.email,
      nom: profile.nom,
      role: profile.role,
      resto_id: profile.resto_id
    },
    restaurant: profile.restaurants ? {
      id: profile.restaurants.id,
      nom: profile.restaurants.nom,
      slug: profile.restaurants.slug
    } : null
  });
});

// Inscription restaurant
app.post('/api/register', async (req, res) => {
  const { email, motDePasse, nomRestaurant, telephone, adresse } = req.body;
  
  if (!email || !motDePasse || !nomRestaurant) {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Email, mot de passe et nom du restaurant sont requis.',
      code: 'MISSING_FIELDS'
    });
  }

  if (!validateEmail(email)) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Format d\'email invalide.',
      code: 'INVALID_EMAIL'
    });
  }

  if (motDePasse.length < 8) {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Le mot de passe doit contenir au moins 8 caractères.',
      code: 'WEAK_PASSWORD'
    });
  }

  if (nomRestaurant.length < 2 || nomRestaurant.length > 100) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Le nom du restaurant doit contenir entre 2 et 100 caractères.',
      code: 'INVALID_NAME'
    });
  }

  const { data: existingUser } = await supabase
    .from('profiles')
    .select('email')
    .eq('email', email)
    .single();

  if (existingUser) {
    return res.status(400).json({ 
      error: 'duplicate_email',
      message: 'Cet email est déjà utilisé par un autre restaurant.',
      code: 'EMAIL_EXISTS'
    });
  }

  const hashedPassword = await bcrypt.hash(motDePasse, SALT_ROUNDS);
  const baseSlug = nomRestaurant.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 50);
  const slug = `${baseSlug}-${Date.now().toString(36)}`;
  
  // CORRECTION : 14 jours d'essai (pas 1 minute)
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const { data: restaurant, error: restoError } = await supabase
    .from('restaurants')
    .insert({ 
      nom: sanitizeString(nomRestaurant), 
      slug, 
      telephone: telephone ? sanitizeString(telephone) : null, 
      adresse: adresse ? sanitizeString(adresse) : null, 
      actif: true, 
      type_etablissement: req.body.typeEtablissement || 'Restaurant',
      subscription_status: 'trial', 
      trial_ends_at: trialEndsAt.toISOString()
    })
    .select()
    .single();

  if (restoError) {
    logSecurity('ERROR', 'Erreur création restaurant', { error: restoError.message });
    return res.status(500).json({ 
      error: 'server_error',
      message: 'Une erreur est survenue lors de la création du restaurant.',
      code: 'CREATE_FAILED'
    });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .insert({ 
      email, 
      resto_id: restaurant.id, 
      nom: sanitizeString(nomRestaurant), 
      mot_de_passe: hashedPassword, 
      role: 'gerant', 
      first_login: false 
    })
    .select()
    .single();

  if (profileError) {
    await supabase.from('restaurants').delete().eq('id', restaurant.id);
    logSecurity('ERROR', 'Erreur création profil', { error: profileError.message });
    return res.status(500).json({ 
      error: 'server_error',
      message: 'Une erreur est survenue lors de la création du compte.',
      code: 'CREATE_FAILED'
    });
  }

  // Création tables par défaut
  for (let i = 1; i <= 10; i++) {
    await supabase.from('tables').insert({ 
      resto_id: restaurant.id, 
      numero_table: i
    });
  }

  const token = jwt.sign(
    { id: profile.id, email, resto_id: restaurant.id, restaurant_name: restaurant.nom, role: 'gerant' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  logSecurity('INFO', 'Nouveau restaurant créé', { email, restaurant: restaurant.nom });

  res.json({ 
    success: true, 
    token, 
    user: {
      id: profile.id,
      email: profile.email,
      nom: profile.nom,
      role: profile.role,
      resto_id: profile.resto_id
    },
    restaurant: {
      id: restaurant.id,
      nom: restaurant.nom,
      slug: restaurant.slug
    },
    trial_ends_at: trialEndsAt,
    trial_days: 14
  });
});

// Magic link
app.get('/api/auth/magic/:token', async (req, res) => {
  const { token } = req.params;
  
  if (!token || token.length < 10) {
    return res.redirect(`${PUBLIC_URL}/set-password.html?error=invalid&message=Lien invalide`);
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('token_unique', token)
    .single();

  if (!profile) {
    return res.redirect(`${PUBLIC_URL}/set-password.html?error=invalid&message=Lien expiré ou invalide`);
  }

  // Vérifier que le lien n'a pas plus de 7 jours
  if (profile.created_at) {
    const linkDate = new Date(profile.created_at);
    const now = new Date();
    const daysDiff = (now - linkDate) / (1000 * 60 * 60 * 24);
    if (daysDiff > 7) {
      return res.redirect(`${PUBLIC_URL}/set-password.html?error=expired&message=Ce lien a expiré. Contactez votre gérant.`);
    }
  }

  res.redirect(`${PUBLIC_URL}/set-password.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(profile.email)}&role=${encodeURIComponent(profile.role)}&resto_id=${encodeURIComponent(profile.resto_id)}`);
});

app.post('/api/auth/set-password', async (req, res) => {
  const { token, email, motDePasse, role, restoId } = req.body;
  
  if (!motDePasse || motDePasse.length < 8) {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Le mot de passe doit contenir au moins 8 caractères.',
      code: 'WEAK_PASSWORD'
    });
  }

  const hashedPassword = await bcrypt.hash(motDePasse, SALT_ROUNDS);
  const { data, error } = await supabase
    .from('profiles')
    .update({ 
      mot_de_passe: hashedPassword, 
      first_login: false, 
      reset_token: null, 
      reset_token_expires: null 
    })
    .eq('token_unique', token)
    .select()
    .single();

  if (error || !data) {
    return res.status(400).json({ 
      error: 'invalid_token',
      message: 'Lien invalide ou expiré. Contactez votre gérant.',
      code: 'TOKEN_INVALID'
    });
  }

  const jwtToken = jwt.sign(
    { id: data.id, email: data.email, resto_id: data.resto_id, role: data.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ success: true, token: jwtToken });
});

// Mot de passe oublié
app.post('/api/auth/forgot-password', loginLimiter, async (req, res) => {
  const { email } = req.body;
  
  if (!email || !validateEmail(email)) {
    // Pour des raisons de sécurité, ne pas révéler si l'email existe
    return res.json({ 
      success: true, 
      message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' 
    });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();

  if (!profile) {
    return res.json({ 
      success: true, 
      message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' 
    });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenExpires = new Date(Date.now() + 3600000); // 1 heure

  await supabase.from('profiles').update({ 
    reset_token: resetToken, 
    reset_token_expires: resetTokenExpires.toISOString() 
  }).eq('id', profile.id);

  const resetUrl = `${PUBLIC_URL}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(email)}`;
  
  // TODO: Envoyer l'email avec Mailjet/Brevo
  logSecurity('INFO', 'Demande réinitialisation mot de passe', { email, resetUrl });

  res.json({ 
    success: true, 
    message: 'Un lien de réinitialisation a été envoyé à votre adresse email.',
    resetUrl // À retirer en production quand l'email est configuré
  });
});

app.post('/api/auth/reset-password', loginLimiter, async (req, res) => {
  const { token, email, motDePasse } = req.body;
  
  if (!motDePasse || motDePasse.length < 8) {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Le mot de passe doit contenir au moins 8 caractères.',
      code: 'WEAK_PASSWORD'
    });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .eq('reset_token', token)
    .single();

  if (!profile || new Date() > new Date(profile.reset_token_expires)) {
    return res.status(400).json({ 
      error: 'invalid_token',
      message: 'Lien de réinitialisation invalide ou expiré.',
      code: 'TOKEN_EXPIRED'
    });
  }

  const hashedPassword = await bcrypt.hash(motDePasse, SALT_ROUNDS);
  await supabase.from('profiles').update({ 
    mot_de_passe: hashedPassword, 
    reset_token: null, 
    reset_token_expires: null 
  }).eq('id', profile.id);

  res.json({ 
    success: true, 
    message: 'Votre mot de passe a été réinitialisé avec succès.' 
  });
});

// ==================== MENU PUBLIC ====================
app.get('/api/menu/:restoId', async (req, res) => {
  const { restoId } = req.params;
  
  if (!restoId || restoId === 'null' || restoId === 'undefined') {
    return res.status(400).json({ error: 'ID restaurant invalide' });
  }

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('actif, subscription_status, trial_ends_at, subscription_ends_at, nom')
    .eq('id', restoId)
    .single();

  if (!restaurant) {
    return res.status(404).json({ error: 'Restaurant non trouvé' });
  }

  if (!restaurant.actif) {
    return res.status(403).json({ error: 'Ce restaurant est temporairement indisponible' });
  }

  const { data, error } = await supabase
    .from('menus')
    .select('*')
    .eq('resto_id', restoId)
    .eq('disponible', true)
    .order('categorie')
    .order('nom_plat');

  if (error) {
    logSecurity('ERROR', 'Erreur chargement menu', { restoId, error: error.message });
    return res.status(500).json({ error: 'Erreur lors du chargement du menu' });
  }

  res.json({
    restaurant: restaurant.nom,
    menu: data
  });
});

// ==================== COMMANDES PUBLIQUES ====================
app.post('/api/commande', commandLimiter, async (req, res) => {
  const { restoId, tableId, clientName, items, total } = req.body;
  
  if (!restoId || !tableId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Commande invalide. Vérifiez les articles.',
      code: 'INVALID_ORDER'
    });
  }

  if (items.length > 50) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Maximum 50 articles par commande.',
      code: 'TOO_MANY_ITEMS'
    });
  }

  if (total === undefined || total === null || isNaN(total) || Number(total) < 0) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'Montant total invalide.',
      code: 'INVALID_TOTAL'
    });
  }

  // Vérifier que le restaurant existe et est actif
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('actif, id')
    .eq('id', restoId)
    .single();

  if (!restaurant || !restaurant.actif) {
    return res.status(404).json({ error: 'Restaurant indisponible' });
  }

  // Chercher la table par numero_table ou par id
  let tableIdFinal = tableId;
  const tableIdNum = parseInt(tableId);
  
  // Si tableId est un numéro de table (1-10), chercher l'ID réel
  if (!isNaN(tableIdNum) && tableIdNum <= 100) {
    const { data: tableByNumero } = await supabase
      .from('tables')
      .select('id')
      .eq('resto_id', restoId)
      .eq('numero_table', tableIdNum)
      .single();
    
    if (tableByNumero) {
      tableIdFinal = tableByNumero.id;
    }
  }

  // Vérifier que la table existe
  const { data: table } = await supabase
    .from('tables')
    .select('id')
    .eq('id', tableIdFinal)
    .eq('resto_id', restoId)
    .single();

  if (!table) {
    return res.status(400).json({ error: 'Table invalide' });
  }

  const name = clientName ? sanitizeString(clientName).substring(0, 50) : 'Client';

  const { data: commande, error: commandeError } = await supabase
    .from('commandes')
    .insert({ 
      resto_id: restoId, 
      table_id: tableIdFinal, 
      client_nom: name, 
      total: Math.round(Number(total)),
      statut: 'en_attente'
    })
    .select()
    .single();

  if (commandeError) {
    logSecurity('ERROR', 'Erreur création commande', { error: commandeError.message });
    return res.status(500).json({ error: 'Impossible de créer la commande' });
  }

  const detailsPromises = items.map(item => {
    return supabase.from('commande_details').insert({
      commande_id: commande.id,
      menu_id: item.menuId,
      quantite: Math.min(parseInt(item.quantite) || 1, 99),
      prix_unitaire: Math.round(Number(item.prix) || 0),
      nom_plat: sanitizeString(item.nom || '').substring(0, 100)
    });
  });

  await Promise.all(detailsPromises);

  io.to(`resto_${restoId}`).emit('nouvelle_commande', {
    commande_id: commande.id,
    table_id: tableId,
    client_name: name,
    items: items.map(i => ({
      nom: sanitizeString(i.nom || ''),
      quantite: parseInt(i.quantite) || 1
    })),
    total: Math.round(Number(total)),
    statut: 'en_attente'
  });

  logSecurity('INFO', 'Nouvelle commande', { restoId, commandeId: commande.id });

  res.json({ 
    success: true, 
    commande_id: commande.id,
    message: 'Votre commande a été envoyée en cuisine !'
  });
});

// Commande manuelle (serveur)
app.post('/api/commande-manuelle', authMiddleware, async (req, res) => {
  const { restoId, tableId, clientName, items, total, source } = req.body;
  
  if (!restoId || !tableId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Commande invalide' });
  }

  if (total === undefined || isNaN(total) || Number(total) < 0) {
    return res.status(400).json({ error: 'Montant total invalide' });
  }

  const name = clientName ? sanitizeString(clientName).substring(0, 50) : 'Client';
  const commandeSource = source || 'manuelle';

  // Chercher l'ID réel de la table
  let tableIdFinal = tableId;
  const tableIdNum = parseInt(tableId);
  if (!isNaN(tableIdNum) && tableIdNum <= 100) {
    const { data: tableByNumero } = await supabase
      .from('tables')
      .select('id')
      .eq('resto_id', restoId)
      .eq('numero_table', tableIdNum)
      .single();
    if (tableByNumero) tableIdFinal = tableByNumero.id;
  }

  const { data: commande, error: commandeError } = await supabase
    .from('commandes')
    .insert({ 
      resto_id: restoId, 
      table_id: tableIdFinal, 
      client_nom: name, 
      total: Math.round(Number(total)),
      statut: req.body.statut || 'en_attente',
      source: commandeSource
    })
    .select()
    .single();

  if (commandeError) {
    logSecurity('ERROR', 'Erreur commande manuelle', { error: commandeError.message });
    return res.status(500).json({ error: 'Erreur création commande' });
  }

  // Ajouter les détails
  for (const item of items) {
    await supabase.from('commande_details').insert({
      commande_id: commande.id,
      menu_id: item.menuId || null,
      quantite: Math.min(parseInt(item.quantite) || 1, 99),
      prix_unitaire: Math.round(Number(item.prix) || 0),
      nom_plat: sanitizeString(item.nom || 'Plat').substring(0, 100)
    });
  }

  io.to(`resto_${restoId}`).emit('nouvelle_commande', {
    commande_id: commande.id,
    table_id: tableId,
    client_name: name,
    items: items.map(i => ({ nom: sanitizeString(i.nom || ''), quantite: parseInt(i.quantite) || 1 })),
    total: Math.round(Number(total)),
    statut: 'paye',
    source: commandeSource
  });

  logSecurity('INFO', 'Commande manuelle créée', { restoId, commandeId: commande.id, source: commandeSource });

  res.json({ success: true, commande_id: commande.id, message: 'Commande enregistrée !' });
});

// Modification statut commande
app.put('/api/commande/:id/statut', apiLimiter, async (req, res) => {
  const { id } = req.params;
  const { statut, restoId } = req.body;
  
  if (!statut || !restoId) {
    return res.status(400).json({ error: 'Statut et restoId requis' });
  }

  // Récupérer le statut actuel
  const { data: commande } = await supabase
    .from('commandes')
    .select('statut')
    .eq('id', id)
    .single();

  if (!commande) {
    return res.status(404).json({ error: 'Commande non trouvée' });
  }

  // Vérifier la transition valide
  const transitionsAutorisees = VALID_TRANSITIONS[commande.statut] || [];
  if (!transitionsAutorisees.includes(statut)) {
    return res.status(400).json({
      error: 'transition_invalide',
      message: `Impossible de passer de "${commande.statut}" à "${statut}".`,
      code: 'INVALID_TRANSITION',
      etatActuel: commande.statut,
      transitionsAutorisees
    });
  }

  const { error } = await supabase
    .from('commandes')
    .update({ statut })
    .eq('id', id)
    .eq('resto_id', restoId);

  if (error) {
    logSecurity('ERROR', 'Erreur mise à jour statut', { commandeId: id, error: error.message });
    return res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }

  io.to(`resto_${restoId}`).emit('statut_change', { commande_id: id, statut });

  res.json({ success: true, statut });
});

app.get('/api/commandes/:restoId', async (req, res) => {
  const { restoId } = req.params;

  const { data: commandes, error } = await supabase
    .from('commandes')
    .select(`*, tables(numero_table), commande_details(quantite, prix_unitaire, nom_plat)`)
    .eq('resto_id', restoId)
    .order('date_commande', { ascending: false })
    .limit(100);

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

  const { data: commande } = await supabase
    .from('commandes')
    .select('*')
    .eq('id', id)
    .single();

  if (!commande) {
    return res.status(404).json({ error: 'Commande non trouvée' });
  }

  const { data: details } = await supabase
    .from('commande_details')
    .select('nom_plat, quantite, prix_unitaire')
    .eq('commande_id', id);

  res.json({ 
    id: commande.id, 
    statut: commande.statut, 
    total: commande.total, 
    date_commande: commande.date_commande, 
    details: details || [] 
  });
});

// ==================== QR CODES ====================
app.get('/api/qrcode/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;

    if (!restoId || restoId === 'null' || restoId === 'undefined') {
    return res.status(400).json({ error: 'ID restaurant invalide' });
  }

  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  const qrImage = await QRCode.toDataURL(url, { 
    width: 300, 
    margin: 2,
    color: {
      dark: '#1a1a1a',
      light: '#ffffff'
    }
  });

  res.json({ success: true, qr: qrImage, url });
});

app.get('/api/generate-qr/:restoId/:tableId', async (req, res) => {
  const { restoId, tableId } = req.params;

  const url = `${PUBLIC_URL}/menu.html?resto=${restoId}&table=${tableId}`;
  const qrImage = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  
  const { data: resto } = await supabase
    .from('restaurants')
    .select('nom')
    .eq('id', restoId)
    .single();

  const restoName = resto?.nom || 'Restaurant';

  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Code - ${restoName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      text-align: center;
      padding: 40px;
      background: #faf8f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      max-width: 420px;
      width: 100%;
      padding: 48px 40px;
      border-radius: 24px;
      box-shadow: 0 2px 24px rgba(0,0,0,0.06);
    }
    .restaurant-name {
      font-size: 22px;
      font-weight: normal;
      letter-spacing: 0.5px;
      color: #1a1a1a;
    }
    .restaurant-name span {
      color: #C6A43F;
    }
    .table-number {
      font-size: 52px;
      font-weight: 300;
      color: #C6A43F;
      margin: 24px 0;
      letter-spacing: 2px;
    }
    .table-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 3px;
      color: #999;
      margin-bottom: 4px;
    }
    img {
      width: 220px;
      margin: 24px 0;
    }
    .instruction {
      font-size: 14px;
      color: #666;
      margin-top: 16px;
      font-style: italic;
    }
    .print-btn {
      background: #C6A43F;
      color: white;
      border: none;
      padding: 12px 28px;
      border-radius: 40px;
      cursor: pointer;
      margin-top: 28px;
      font-size: 14px;
      letter-spacing: 0.5px;
      transition: background 0.3s;
    }
    .print-btn:hover {
      background: #b39330;
    }
    .footer {
      margin-top: 32px;
      font-size: 11px;
      color: #ccc;
    }
    @media print {
      body { padding: 0; background: white; }
      .no-print { display: none; }
      .container { box-shadow: none; border-radius: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="restaurant-name">🍽️&nbsp; <span>${restoName}</span></div>
    <div class="table-label">Table</div>
    <div class="table-number">${tableId}</div>
    <img src="${qrImage}" alt="QR Code">
    <div class="instruction">Scannez pour accéder au menu</div>
    <button class="print-btn no-print" onclick="window.print()">🖨️&nbsp; Imprimer</button>
    <div class="footer">RestApp 7★</div>
  </div>
</body>
</html>`);
});

// ==================== ROUTES PROTÉGÉES ====================

// Admin - Plats
app.post('/api/admin/plat', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId, nom_plat, prix, categorie, disponible, description } = req.body;
  const finalRestoId = restoId || req.user.resto_id;

  if (!nom_plat || nom_plat.trim().length < 2) {
    return res.status(400).json({ error: 'Le nom du plat doit contenir au moins 2 caractères' });
  }

  if (!prix || isNaN(prix) || Number(prix) <= 0) {
    return res.status(400).json({ error: 'Le prix doit être un nombre positif' });
  }

  if (!categorie || !VALID_CATEGORIES.includes(categorie)) {
    return res.status(400).json({ error: `Catégorie invalide. Choisissez parmi : ${VALID_CATEGORIES.join(', ')}` });
  }

  const { data, error } = await supabase
    .from('menus')
    .insert({ 
      resto_id: finalRestoId, 
      nom_plat: sanitizeString(nom_plat).substring(0, 100), 
      prix: Math.round(Number(prix)), 
      categorie, 
      disponible: disponible !== false, 
      description: description ? sanitizeString(description).substring(0, 500) : null 
    })
    .select()
    .single();

  if (error) {
    logSecurity('ERROR', 'Erreur création plat', { error: error.message });
    return res.status(500).json({ error: 'Erreur lors de la création du plat' });
  }

  logSecurity('INFO', 'Plat créé', { platId: data.id, nom: data.nom_plat });
  res.json({ success: true, data });
});

app.get('/api/admin/menu/:restoId', checkRole(['gerant', 'serveur', 'superadmin']), async (req, res) => {
  const targetRestoId = req.params.restoId || req.user.resto_id;
  const { data, error } = await supabase
    .from('menus')
    .select('*')
    .eq('resto_id', targetRestoId)
    .order('categorie')
    .order('nom_plat');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/admin/plat/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const updates = {};
  
  if (req.body.nom_plat) updates.nom_plat = sanitizeString(req.body.nom_plat).substring(0, 100);
  if (req.body.prix !== undefined) {
    if (isNaN(req.body.prix) || Number(req.body.prix) <= 0) {
      return res.status(400).json({ error: 'Prix invalide' });
    }
    updates.prix = Math.round(Number(req.body.prix));
  }
  if (req.body.categorie && VALID_CATEGORIES.includes(req.body.categorie)) {
    updates.categorie = req.body.categorie;
  }
  if (req.body.description !== undefined) {
    updates.description = req.body.description ? sanitizeString(req.body.description).substring(0, 500) : null;
  }
  if (req.body.disponible !== undefined) {
    updates.disponible = req.body.disponible;
  }

  const { error } = await supabase.from('menus').update(updates).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  
  res.json({ success: true });
});

app.delete('/api/admin/plat/:id', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  
  // Supprimer la photo si elle existe
  const { data: plat } = await supabase.from('menus').select('photo_url').eq('id', id).single();
  if (plat?.photo_url) {
    const path = plat.photo_url.split('/').slice(-2).join('/');
    await supabase.storage.from('plat-photos').remove([path]);
  }

  const { error } = await supabase.from('menus').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  
  logSecurity('INFO', 'Plat supprimé', { platId: id });
  res.json({ success: true });
});

app.put('/api/admin/plat/:id/disponible', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  const { disponible } = req.body;
  
  const { error } = await supabase.from('menus').update({ disponible }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Stats
app.get('/api/stats/:restoId', checkRole(['gerant', 'superadmin']), async (req, res) => {
  const targetRestoId = req.params.restoId || req.user.resto_id;
  const { periode } = req.query;

  let startDate = null;
  const now = new Date();
  
  if (periode === 'day') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (periode === 'week') {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - 7);
  } else if (periode === 'month') {
    startDate = new Date(now);
    startDate.setMonth(now.getMonth() - 1);
  }

  let query = supabase
    .from('commandes')
    .select('id, total, date_commande, source, statut')
    .eq('resto_id', targetRestoId)
    .eq('statut', 'paye');

  if (startDate) {
    query = query.gte('date_commande', startDate.toISOString());
  }

  const { data: commandes, error } = await query;
  
  if (error) {
    logSecurity('ERROR', 'Erreur chargement stats', { error: error.message });
    return res.status(500).json({ error: 'Erreur lors du chargement des statistiques' });
  }

  const caTotal = commandes?.reduce((s, c) => s + (c.total || 0), 0) || 0;
  const nbCommandes = commandes?.length || 0;
  const panierMoyen = nbCommandes > 0 ? Math.round(caTotal / nbCommandes) : 0;

  // Répartition par source
  const caQR = commandes?.filter(c => c.source === 'qr_code').reduce((s, c) => s + (c.total || 0), 0) || 0;
  const caManuel = commandes?.filter(c => c.source === 'manuelle' || !c.source).reduce((s, c) => s + (c.total || 0), 0) || 0;
  const caDistance = commandes?.filter(c => c.source === 'a_distance' || c.source === 'telephone').reduce((s, c) => s + (c.total || 0), 0) || 0;
  const nbQR = commandes?.filter(c => c.source === 'qr_code').length || 0;
  const nbManuel = commandes?.filter(c => c.source === 'manuelle' || !c.source).length || 0;
  const nbDistance = commandes?.filter(c => c.source === 'a_distance' || c.source === 'telephone').length || 0;

  // Top plats
  const commandeIds = commandes?.map(c => c.id) || [];
  let topPlats = [];
  
  if (commandeIds.length > 0) {
    const { data: details } = await supabase
      .from('commande_details')
      .select('nom_plat, quantite')
      .in('commande_id', commandeIds);

    const ventesParPlat = {};
    details?.forEach(d => {
      ventesParPlat[d.nom_plat] = (ventesParPlat[d.nom_plat] || 0) + (d.quantite || 0);
    });
    
    topPlats = Object.entries(ventesParPlat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([nom, quantite]) => ({ nom, quantite }));
  }

  res.json({ 
    caTotal: Math.round(caTotal), 
    nbCommandes, 
    panierMoyen,
    caQR: Math.round(caQR),
    caManuel: Math.round(caManuel),
    caDistance: Math.round(caDistance),
    nbQR,
    nbManuel,
    nbDistance,
    topPlats 
  });
});

// Tables
app.get('/api/tables/:restoId', checkRole(['gerant', 'serveur', 'superadmin']), async (req, res) => {
  const targetRestoId = req.params.restoId || req.user.resto_id;
  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('resto_id', targetRestoId)
    .order('numero_table');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tables', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { restoId, numeroTable } = req.body;
  const targetRestoId = restoId || req.user.resto_id;
  
  if (!numeroTable || isNaN(numeroTable) || Number(numeroTable) < 1 || Number(numeroTable) > 999) {
    return res.status(400).json({ error: 'Numéro de table invalide (1-999)' });
  }

  const { data, error } = await supabase
    .from('tables')
    .insert({ 
      resto_id: targetRestoId, 
      numero_table: Math.floor(Number(numeroTable))
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.delete('/api/tables/:id', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  
  // Vérifier qu'aucune commande n'est en cours sur cette table
  const { data: commandesEnCours } = await supabase
    .from('commandes')
    .select('id')
    .eq('table_id', id)
    .in('statut', ['en_attente', 'cuisine', 'pret'])
    .limit(1);

  if (commandesEnCours && commandesEnCours.length > 0) {
    return res.status(400).json({ 
      error: 'table_active',
      message: 'Impossible de supprimer cette table. Des commandes sont en cours.'
    });
  }

  const { error } = await supabase.from('tables').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Upload photos
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5 Mo max
    files: 1 
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format non supporté. Utilisez JPG, PNG ou WebP.'), false);
    }
  }
});

app.post('/api/upload-plat-photo/:platId', authMiddleware, upload.single('photo'), async (req, res) => {
  const { platId } = req.params;
  const file = req.file;
  
  if (!file) {
    return res.status(400).json({ error: 'Aucune photo envoyée' });
  }

  app.delete('/api/delete-photo/:platId', authMiddleware, async (req, res) => {
  const { platId } = req.params;
  const { data: plat } = await supabase.from('menus').select('photo_url').eq('id', platId).single();
  if (plat?.photo_url) {
    const path = plat.photo_url.split('/').slice(-2).join('/');
    await supabase.storage.from('plat-photos').remove([path]);
  }
  await supabase.from('menus').update({ photo_url: null }).eq('id', platId);
  res.json({ success: true });
});

  const fileName = `plat_${platId}_${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from('plat-photos')
    .upload(`plats/${fileName}`, file.buffer, { 
      contentType: file.mimetype,
      cacheControl: '3600',
      upsert: true
    });

  if (error) {
    logSecurity('ERROR', 'Erreur upload photo', { platId, error: error.message });
    return res.status(500).json({ error: 'Erreur lors de l\'upload de la photo' });
  }

  const { data: urlData } = supabase.storage.from('plat-photos').getPublicUrl(`plats/${fileName}`);
  await supabase.from('menus').update({ photo_url: urlData.publicUrl }).eq('id', platId);
  
  res.json({ success: true, photoUrl: urlData.publicUrl });
});

// ==================== EMPLOYÉS ====================
app.get('/api/employes', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
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

app.post('/api/employes', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { nom, prenom, role } = req.body;
  
  if (!nom || nom.trim().length < 2) {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Le nom doit contenir au moins 2 caractères.',
      code: 'INVALID_NAME'
    });
  }

  if (!role || !VALID_ROLES.includes(role) || role === 'gerant' || role === 'superadmin') {
    return res.status(400).json({ 
      error: 'validation_error',
      message: 'Rôle invalide. Choisissez cuisinier ou serveur.',
      code: 'INVALID_ROLE'
    });
  }

  const tokenUnique = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const lienUnique = `${PUBLIC_URL}/magic.html?token=${tokenUnique}`;

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      nom: sanitizeString(nom).substring(0, 50),
      prenom: prenom ? sanitizeString(prenom).substring(0, 50) : '',
      resto_id: req.user.resto_id,
      role,
      token_unique: tokenUnique,
      lien_unique: lienUnique,
      email: `${tokenUnique}@invite.restapp.com`,
      first_login: true
    })
    .select()
    .single();

  if (error) {
    logSecurity('ERROR', 'Erreur création employé', { error: error.message });
    return res.status(500).json({ error: 'Erreur lors de la création de l\'employé' });
  }

  logSecurity('INFO', 'Employé créé', { employeId: data.id, role });

  res.json({ 
    success: true, 
    employe: data, 
    lien: lienUnique, 
    nom: `${prenom || ''} ${nom}`.trim(), 
    role: role === 'cuisinier' ? 'Cuisinier' : 'Serveur' 
  });
});

app.delete('/api/employes/:id', authMiddleware, checkRole(['gerant', 'superadmin']), async (req, res) => {
  const { id } = req.params;
  
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
  }

  const { error } = await supabase
    .from('profiles')
    .delete()
    .eq('id', id)
    .eq('resto_id', req.user.resto_id);

  if (error) return res.status(500).json({ error: error.message });
  
  logSecurity('INFO', 'Employé supprimé', { employeId: id });
  res.json({ success: true });
});

// ==================== ABONNEMENT ====================
app.get('/api/restaurant/subscription', authMiddleware, async (req, res) => {
  const { data: restaurant, error } = await supabase
    .from('restaurants')
    .select('subscription_status, trial_ends_at, subscription_ends_at, nom')
    .eq('id', req.user.resto_id)
    .single();

  if (error || !restaurant) {
    return res.status(404).json({ error: 'Restaurant non trouvé' });
  }

  const response = { 
    status: restaurant.subscription_status,
    restaurant_name: restaurant.nom
  };
  
  if (restaurant.subscription_status === 'trial') {
    const now = new Date();
    const endsAt = new Date(restaurant.trial_ends_at);
    const daysLeft = Math.ceil((endsAt - now) / (1000 * 60 * 60 * 24));
    response.days_left = Math.max(0, daysLeft);
    response.ends_at = restaurant.trial_ends_at;
    response.trial = true;
  } else if (restaurant.subscription_status === 'active') {
    response.ends_at = restaurant.subscription_ends_at;
    response.active = true;
  }
  
  res.json(response);
});

app.get('/api/restaurant/transactions', authMiddleware, async (req, res) => {
  const restoId = req.user.resto_id;
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('resto_id', restoId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Paiement - CORRECTION : durée en mois, pas en minutes
app.post('/api/subscription/renew', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  const restoId = req.user.resto_id;
  const profileId = req.user.id;

  const plans = {
    monthly: { amount: 25000, months: 1, name: 'Mensuel' },
    quarterly: { amount: 60000, months: 3, name: 'Trimestriel' },
    yearly: { amount: 200000, months: 12, name: 'Annuel' }
  };

  if (!plan || !plans[plan]) {
    return res.status(400).json({ 
      error: 'plan_invalide',
      message: 'Plan invalide. Choisissez monthly, quarterly ou yearly.',
      code: 'INVALID_PLAN'
    });
  }

  const config = plans[plan];
  const startDate = new Date();
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + config.months); // CORRECTION : mois, pas minutes

  try {
    await supabase
      .from('restaurants')
      .update({ 
        subscription_status: 'active', 
        subscription_ends_at: endDate.toISOString() 
      })
      .eq('id', restoId);

    const transactionRef = `PAY_${restoId}_${Date.now().toString(36)}`;
    await supabase.from('transactions').insert({
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

    logSecurity('INFO', 'Abonnement renouvelé', { 
      restoId, 
      plan, 
      amount: config.amount,
      endDate: endDate.toISOString()
    });

    res.json({ 
      success: true, 
      message: `✅ Abonnement ${config.name} activé avec succès ! Valable jusqu'au ${endDate.toLocaleDateString('fr-FR')}.`,
      end_date: endDate,
      plan: config.name,
      amount: config.amount
    });
  } catch (error) {
    logSecurity('ERROR', 'Erreur paiement', { restoId, error: error.message });
    res.status(500).json({ 
      error: 'payment_failed',
      message: 'Le paiement a échoué. Veuillez réessayer.'
    });
  }
});

// ==================== SUPER ADMIN ====================
app.get('/api/superadmin/restaurants', checkRole(['superadmin']), async (req, res) => {
  const { data, error } = await supabase
    .from('restaurants')
    .select('*, profiles(email)')
    .order('id', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  
  // Formater pour extraire l'email du gérant
  const formatted = data.map(r => ({
    ...r,
    email_gerant: r.profiles?.length > 0 ? r.profiles[0]?.email : null
  }));
  
  res.json(formatted);
});

app.get('/api/superadmin/stats', checkRole(['superadmin']), async (req, res) => {
  const { data: restaurants } = await supabase.from('restaurants').select('id, nom, subscription_status');
  const { count: nbCommandes } = await supabase.from('commandes').select('*', { count: 'exact', head: true });
  const { data: transactions } = await supabase.from('transactions').select('amount').eq('status', 'paid');
  const { count: nbEmployes } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).neq('role', 'superadmin');

  const caTotal = transactions?.reduce((s, t) => s + (t.amount || 0), 0) || 0;

  res.json({
    nbRestaurants: restaurants?.length || 0,
    nbCommandes: nbCommandes || 0,
    caTotal,
    nbEmployes: nbEmployes || 0,
    restaurants: restaurants || []
  });
});

// Supprimer un restaurant (superadmin)
app.post('/api/superadmin/delete-restaurant', checkRole(['superadmin']), async (req, res) => {
  const { resto_id } = req.body;
  if (!resto_id) return res.status(400).json({ error: 'resto_id requis' });

  try {
    await supabase.from('commande_details').delete().eq('commande_id', null); // skip
    await supabase.from('commandes').delete().eq('resto_id', resto_id);
    await supabase.from('menus').delete().eq('resto_id', resto_id);
    await supabase.from('tables').delete().eq('resto_id', resto_id);
    await supabase.from('transactions').delete().eq('resto_id', resto_id);
    await supabase.from('profiles').delete().eq('resto_id', resto_id);
    await supabase.from('restaurants').delete().eq('id', resto_id);

    logSecurity('INFO', 'Restaurant supprimé par superadmin', { resto_id });
    res.json({ success: true, message: 'Restaurant supprimé' });
  } catch(e) {
    logSecurity('ERROR', 'Erreur suppression restaurant', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ==================== WEBSOCKETS ====================
io.on('connection', (socket) => {
  logSecurity('INFO', 'Client WebSocket connecté', { socketId: socket.id });

  socket.on('join_resto', (restoId) => {
    if (restoId) {
      socket.join(`resto_${restoId}`);
      logSecurity('INFO', 'Client rejoint resto', { socketId: socket.id, restoId });
    }
  });

  socket.on('leave_resto', (restoId) => {
    if (restoId) {
      socket.leave(`resto_${restoId}`);
    }
  });

  socket.on('disconnect', () => {
    logSecurity('INFO', 'Client WebSocket déconnecté', { socketId: socket.id });
  });
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ==================== GESTION ERREURS ====================
app.use((err, req, res, next) => {
  logSecurity('ERROR', 'Erreur serveur', { 
    error: err.message, 
    path: req.path,
    method: req.method
  });
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'La photo ne doit pas dépasser 5 Mo' });
    }
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ 
    error: 'server_error',
    message: 'Une erreur interne est survenue. L\'équipe technique a été notifiée.'
  });
});

app.use((req, res) => {
  res.status(404).json({ 
    error: 'not_found',
    message: 'Route non trouvée'
  });
});

// ==================== LANCEMENT ====================
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  logSecurity('INFO', `🚀 Serveur 7 Étoiles démarré sur le port ${PORT}`);
  console.log(`   📡 API : http://localhost:${PORT}/api/health`);
  console.log(`   🌐 Public : ${PUBLIC_URL}`);
});