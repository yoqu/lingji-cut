import type { ProductionMutationGuard } from './production-mutations';

let activeRegistration: { guard: ProductionMutationGuard } | null = null;

export function registerProductionSaveGuard(
  guard: ProductionMutationGuard,
): () => void {
  const registration = { guard };
  activeRegistration = registration;
  return () => {
    if (activeRegistration === registration) activeRegistration = null;
  };
}

export function getProductionSaveGuard(): ProductionMutationGuard | undefined {
  return activeRegistration?.guard;
}
