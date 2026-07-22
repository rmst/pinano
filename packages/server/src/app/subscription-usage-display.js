// Automatic subscription usage chrome is visible by default. Managed demos can
// suppress it without disabling usage fetching, logging, or explicit /usage.

/** @param {{ showSubscriptionUsageStatus?: boolean } | undefined} settings */
export function showSubscriptionUsageStatusFromSettings(settings) {
	return settings?.showSubscriptionUsageStatus !== false
}
