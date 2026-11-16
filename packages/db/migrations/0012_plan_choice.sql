-- 0012_plan_choice: remember the plan a visitor picked on /pricing (OL-E5 follow-up). Additive only.
--
-- Billing isn't switched on yet: every workspace is still a 14-day trial (plan = 'trial'). These
-- columns only record which paid plan the team intends to move to, so the choice survives sign-up
-- or sign-in and can be confirmed before any payment. Nothing reads them to charge anyone.
--
-- workspaces.chosen_plan     solo | team | growth | scale, NULL when no plan was picked yet.
-- workspaces.chosen_billing  monthly | annual, NULL when no plan was picked yet.
--
-- The existing workspaces_read / workspaces_update policies and table grants cover the new columns.

ALTER TABLE workspaces
  ADD COLUMN chosen_plan text
    CONSTRAINT workspaces_chosen_plan_check CHECK (chosen_plan IN ('solo', 'team', 'growth', 'scale')),
  ADD COLUMN chosen_billing text
    CONSTRAINT workspaces_chosen_billing_check CHECK (chosen_billing IN ('monthly', 'annual'));
