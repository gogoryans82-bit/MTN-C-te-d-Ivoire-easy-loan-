// ============================================================
// terms.js – MTN Mobile Money Côte d'Ivoire
// Conditions Générales de Prêt
// ============================================================
'use strict';

const TNC_VERSION = '1.0';
const TNC_EFFECTIVE = '2026-01-01';

const TERMS_TEXT = `MTN MOBILE MONEY CÔTE D'IVOIRE – CONDITIONS GÉNÉRALES DE PRÊT
Version ${TNC_VERSION} · En vigueur le ${TNC_EFFECTIVE}

1. PARTIES
Le présent contrat est conclu entre MTN Mobile Money Côte d'Ivoire
("le Prêteur") et le demandeur dont les informations sont recueillies
lors de l'inscription ("l'Emprunteur").

2. ÉLIGIBILITÉ
   • Être âgé de 18 ans ou plus
   • Détenir une Carte Nationale d'Identité (CNI) valide
   • Posséder un compte MTN Mobile Money actif
   • Fournir des informations exactes et complètes

3. CONDITIONS DU PRÊT
   • Montant minimum : 25 000 F CFA
   • Montant maximum : selon le niveau BCEAO du compte MoMo
     (Simplifié / Standard / Premium)
   • Taux d'intérêt : 24 % par an, composé mensuellement
   • Remboursement : mensualités fixes selon l'échéancier convenu
   • Aucun frais caché — tous les frais sont divulgués avant acceptation

4. CONDITIONS DE QUALIFICATION
L'Emprunteur doit démontrer une activité MoMo équivalente à 20 % du
montant demandé au cours du mois en cours (Option A), OU fournir un
garant enregistré sur MoMo (Option B).

5. GARANT
   • Le garant accepte une responsabilité solidaire
   • Le garant confirme son consentement à agir en tant que garant
   • En cas de défaut de l'Emprunteur, le Prêteur peut recouvrer le
     solde impayé auprès du Garant

6. REMBOURSEMENT
   • La première échéance est due 30 jours après le décaissement
   • Les paiements sont débités du portefeuille MoMo de l'Emprunteur
   • Le remboursement anticipé est autorisé sans pénalité

7. DÉFAUT DE PAIEMENT
En cas de non-paiement d'une échéance dans les 5 (cinq) jours suivant
la date d'échéance, le prêt est en défaut. Conséquences possibles :
   • Pénalité de retard telle que prévue par la loi
   • Poursuites judiciaires et frais de recouvrement
   • Inscription négative auprès des bureaux de crédit
   • Responsabilité immédiate du Garant

8. PROTECTION DES DONNÉES
En acceptant ces Conditions, l'Emprunteur consent expressément à :
   • La collecte du numéro de CNI, date de naissance, téléphone,
     email et historique de transactions MoMo
   • La vérification de la CNI auprès des autorités compétentes
   • Le partage des données avec les bureaux de crédit et MTN MoMo
   • Le traitement des données pour l'évaluation, le décaissement
     et le recouvrement du prêt

9. PÉRIODE DE RÉTRACTATION
L'Emprunteur peut annuler ce contrat dans les 5 (cinq) jours ouvrables
suivant l'acceptation, sans pénalité.

10. RÈGLEMENT DES LITIGES
Les litiges seront résolus à l'amiable ou devant les juridictions
compétentes de Côte d'Ivoire.

11. DROIT APPLICABLE
Ce contrat est régi par le droit ivoirien et les règlements de la
BCEAO (Banque Centrale des États de l'Afrique de l'Ouest).

12. ACCEPTATION
En cochant la case d'acceptation lors de l'inscription, l'Emprunteur
confirme :
   • Avoir lu et compris ces Conditions
   • Fournir des informations exactes et complètes
   • Être âgé de 18 ans ou plus
   • Accepter la responsabilité solidaire avec le Garant

© 2026 MTN Mobile Money Côte d'Ivoire · Tous droits réservés`;

module.exports = { TNC_VERSION, TNC_EFFECTIVE, TERMS_TEXT };
