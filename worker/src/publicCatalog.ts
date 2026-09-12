import type { BillingOfferView } from '../../lib/commercial/contracts-v3.ts';
import type { PublicPlanView } from '../../lib/commercial/contracts-v11.ts';

const COPY = {
  discovery: {
    displayName: 'Gratuite',
    description: 'Pour écrire et mettre en page vos scénarios sur votre appareil.',
    features: [
      'Éditeur de scénario et mise en page automatique',
      'Projets enregistrés sur votre appareil',
      'Page de garde et export PDF',
      'Commentaires locaux',
    ],
  },
  author_ai: {
    displayName: 'Auteur',
    description: 'Pour écrire davantage et bénéficier des outils d’aide à la création.',
    features: [
      'Toutes les fonctionnalités de l’offre Gratuite',
      'Projets locaux illimités',
      'Aide IA pour les actions et les dialogues',
      'Import PDF assisté par IA',
    ],
  },
  studio: {
    displayName: 'Studio',
    description: 'Pour conserver des projets dans le cloud et travailler à plusieurs.',
    features: [
      'Toutes les fonctionnalités de l’offre Auteur',
      'Projets cloud privés ou partagés',
      'Collaboration et présence en temps réel',
      'Invitations avec rôles éditeur et lecteur',
      'Versions, restauration, commentaires et premières pages partagés',
    ],
  },
} as const;

export function buildPublicPlans(offers: BillingOfferView[]): PublicPlanView[] {
  const paid = offers.filter((offer) => offer.testMode && ['author_ai', 'studio'].includes(offer.offerCode));
  const byPlan = (offerCode: 'author_ai' | 'studio') => {
    const prices = paid.filter((offer) => offer.offerCode === offerCode);
    if (prices.length !== 2 || new Set(prices.map((price) => price.billingInterval)).size !== 2 ||
        !prices.some((price) => price.billingInterval === 'month') || !prices.some((price) => price.billingInterval === 'year') ||
        new Set(prices.map((price) => price.currency.toUpperCase())).size !== 1)
      throw new Error(`Incomplete public catalogue for ${offerCode}`);
    return prices.map((price) => ({
      selectionId: price.selectionId,
      billingInterval: price.billingInterval,
      currency: price.currency.toUpperCase(),
      unitAmountMinor: price.unitAmountMinor,
      testMode: true as const,
    })).sort((left, right) => left.billingInterval.localeCompare(right.billingInterval));
  };
  return [
    {
      offerCode: 'discovery', displayName: COPY.discovery.displayName,
      description: COPY.discovery.description, featured: false,
      features: [...COPY.discovery.features],
      prices: [{ selectionId: null, billingInterval: 'none', currency: 'EUR', unitAmountMinor: 0, testMode: true }],
    },
    {
      offerCode: 'author_ai', displayName: COPY.author_ai.displayName,
      description: COPY.author_ai.description, featured: true,
      features: [...COPY.author_ai.features], prices: byPlan('author_ai'),
    },
    {
      offerCode: 'studio', displayName: COPY.studio.displayName,
      description: COPY.studio.description, featured: false,
      features: [...COPY.studio.features], prices: byPlan('studio'),
    },
  ];
}
