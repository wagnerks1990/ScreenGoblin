export function assertE2eEnvironment(
  environment: Record<string, string | undefined>,
): Readonly<{
  apiBaseUrl: string;
  mediaOrigin: string;
  organizationSlug: string;
}>;

export function waitForFreshLoginBudgetWindow(
  firstLoginCompletedAt: number,
  options?: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<void>;
