export interface ReminderDeliveryRequest {
  reminderEventId: string;
  leaseId: string;
  channel: "email" | "line";
  occurrenceKey: string;
  templateId: string;
  payload: Record<string, unknown>;
}

export interface ReminderDeliveryResult {
  reminderEventId: string;
  delivered: boolean;
  providerRef?: string;
}

export interface ReminderDeliveryAdapter {
  deliver(req: ReminderDeliveryRequest): Promise<ReminderDeliveryResult>;
}

export function createMemoryDeliveryAdapter(): ReminderDeliveryAdapter & {
  sent: ReminderDeliveryRequest[];
} {
  const sent: ReminderDeliveryRequest[] = [];
  const deliveries = new Map<
    string,
    Map<ReminderDeliveryRequest["channel"], ReminderDeliveryResult>
  >();
  let nextProviderId = 1;

  return {
    sent,

    async deliver(
      req: ReminderDeliveryRequest,
    ): Promise<ReminderDeliveryResult> {
      let channels = deliveries.get(req.reminderEventId);
      const existing = channels?.get(req.channel);

      if (existing) {
        return { ...existing };
      }

      const result: ReminderDeliveryResult = {
        reminderEventId: req.reminderEventId,
        delivered: true,
        providerRef: `memory:${nextProviderId++}`,
      };

      if (!channels) {
        channels = new Map();
        deliveries.set(req.reminderEventId, channels);
      }

      channels.set(req.channel, result);
      sent.push(req);

      return { ...result };
    },
  };
}
