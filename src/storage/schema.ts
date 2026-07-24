/** Authoritative consolidated schema marker. Runtime SQL is kept in the
 * checked-in migration stream so fresh installs and upgrades share one source
 * of truth. */
export const consolidatedSchema = "marshal.db" as const;
