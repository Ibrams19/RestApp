// backend/middleware/checkSubscription.js

const supabase = require('../config/supabase'); // ← Adaptez le chemin selon votre config

/**
 * Middleware qui vérifie si l'abonnement du restaurant est valide
 * Doit être utilisé APRÈS le middleware d'authentification (verifyToken)
 */
const checkSubscription = async (req, res, next) => {
    try {
        // req.user doit venir du middleware d'authentification JWT
        if (!req.user || !req.user.restaurant_id) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Authentification requise"
            });
        }

        const { data: restaurant, error } = await supabase
            .from('restaurants')
            .select('id, name, subscription_status, trial_ends_at, subscription_ends_at')
            .eq('id', req.user.restaurant_id)
            .single();

        if (error || !restaurant) {
            return res.status(403).json({
                error: "restaurant_not_found",
                message: "Restaurant non trouvé"
            });
        }

        const now = new Date();
        let isValid = false;
        let status = restaurant.subscription_status;

        // Vérification selon le statut
        if (status === 'active') {
            if (restaurant.subscription_ends_at) {
                isValid = now <= new Date(restaurant.subscription_ends_at);
            }
        } 
        else if (status === 'trial') {
            if (restaurant.trial_ends_at) {
                isValid = now <= new Date(restaurant.trial_ends_at);
            }
        } 
        else if (status === 'expired' || status === 'suspended') {
            isValid = false;
        }

        // Mise à jour automatique du statut si expiré
        if (!isValid && (status === 'trial' || status === 'active')) {
            await supabase
                .from('restaurants')
                .update({ subscription_status: 'expired' })
                .eq('id', restaurant.id);
            
            status = 'expired';
        }

        if (!isValid) {
            return res.status(403).json({
                error: "subscription_expired",
                message: "Votre abonnement a expiré. Veuillez le renouveler pour continuer à utiliser le service.",
                redirect: "/subscription-renew.html",
                restaurantName: restaurant.name,
                status: status
            });
        }

        // Abonnement valide → on passe à la suite
        req.restaurant = restaurant; // On peut accéder aux infos du restaurant dans les routes
        next();

    } catch (err) {
        console.error("Erreur dans checkSubscription middleware:", err);
        res.status(500).json({
            error: "server_error",
            message: "Erreur lors de la vérification de l'abonnement"
        });
    }
};

module.exports = checkSubscription;