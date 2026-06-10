-- PA-175 follow-up: team rename + optional invitee name.
--
-- 1. customer_settings.team_name — Owner-editable display name for the team
--    shown in the account switcher + dashboard header. NULL falls back to
--    the Stripe customer's email in the UI.
-- 2. team_invitation.invitee_name — optional display name set by the inviter,
--    populated to user.display_name when the invitee accepts.

ALTER TABLE `customer_settings`
  ADD COLUMN `team_name` VARCHAR(255) NULL;

ALTER TABLE `team_invitation`
  ADD COLUMN `invitee_name` VARCHAR(255) NULL;
