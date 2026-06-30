import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import {
  lookupPacketUserIdByEmail,
  getTicketsByCustomer,
  getTicketArticles,
  isTicketClosed,
} from "@/lib/zammad";

/**
 * Lean unread-badge endpoint (PA-226).
 *
 * The dashboard polls this in the background to render the red "unread" dot.
 * It MUST be cheap: previously the badge hit GET /api/support/tickets which
 * did 3 + N Zammad API calls per poll (org search, user search, ticket search,
 * one article fetch per ticket) and was responsible for ~3 req/s sustained
 * Zammad load.
 *
 * Steady-state cost here: 1 ticket-search call. Cached user-id lookup, no
 * org/user create, no article fetches unless a ticket actually looks like
 * it might have an unread agent reply.
 *
 * The full create-org / create-user path still runs on the Support tab and
 * on POST /api/support/tickets — only this poll endpoint is slimmed down.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    const { payload } = auth;

    // Cached lookup, no create. If the customer has never opened a ticket
    // they won't have a Zammad user yet — they can't have unread replies.
    const userId = await lookupPacketUserIdByEmail(payload.email);
    if (!userId) {
      return NextResponse.json({ success: true, hasUnreadReplies: false });
    }

    const tickets = await getTicketsByCustomer(userId);

    // Narrow to tickets where the agent contacted more recently than the
    // customer and which aren't closed. last_contact_agent_at is also bumped
    // by internal-only agent notes, so we still confirm with an article fetch
    // — but only for the candidates, and we stop at the first confirmed hit.
    let hasUnreadReplies = false;
    for (const ticket of tickets) {
      const agentAt = ticket.last_contact_agent_at;
      if (!agentAt) continue;
      const customerAt = ticket.last_contact_customer_at;
      if (customerAt && new Date(customerAt).getTime() >= new Date(agentAt).getTime()) {
        continue;
      }
      if (await isTicketClosed(ticket)) continue;

      const articles = (await getTicketArticles(ticket.id)) as Array<{
        internal?: boolean;
        sender?: string;
      }>;
      const publicArticles = articles.filter((a) => !a.internal);
      const lastArticle = publicArticles[publicArticles.length - 1];
      if (lastArticle && lastArticle.sender !== "Customer") {
        hasUnreadReplies = true;
        break;
      }
    }

    return NextResponse.json({ success: true, hasUnreadReplies });
  } catch (error) {
    console.error("Failed to check unread support replies:", error);
    return NextResponse.json(
      {
        error: "Failed to check unread support replies",
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
