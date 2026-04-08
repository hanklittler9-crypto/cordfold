-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "ProofType" AS ENUM ('OAUTH', 'BOT', 'MANUAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "discord_id" TEXT NOT NULL,
    "discord_username" TEXT NOT NULL,
    "discriminator" TEXT,
    "avatar_hash" TEXT,
    "email" TEXT,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT,
    "bio" TEXT,
    "avatar_url" TEXT,
    "banner_url" TEXT,
    "social_links" JSONB NOT NULL DEFAULT '[]',
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "plan_expires_at" TIMESTAMP(3),
    "stripe_customer_id" TEXT,
    "theme_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verified_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "guild_name" TEXT NOT NULL,
    "guild_icon_hash" TEXT,
    "role_id" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "role_color" INTEGER,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "proof_type" "ProofType" NOT NULL DEFAULT 'OAUTH',
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "custom_label" TEXT,

    CONSTRAINT "verified_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "themes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_preset" BOOLEAN NOT NULL DEFAULT false,
    "is_pro" BOOLEAN NOT NULL DEFAULT false,
    "background_color" TEXT NOT NULL DEFAULT '#0d0d0d',
    "accent_color" TEXT NOT NULL DEFAULT '#5865F2',
    "text_color" TEXT NOT NULL DEFAULT '#ffffff',
    "card_color" TEXT NOT NULL DEFAULT '#111111',
    "glass_enabled" BOOLEAN NOT NULL DEFAULT false,
    "glass_blur" INTEGER NOT NULL DEFAULT 12,
    "glass_opacity" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "animated_bg" BOOLEAN NOT NULL DEFAULT false,
    "custom_css" TEXT,
    "music_url" TEXT,
    "music_autoplay" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_discord_id_key" ON "users"("discord_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_slug_key" ON "users"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "users_slug_idx" ON "users"("slug");

-- CreateIndex
CREATE INDEX "users_discord_id_idx" ON "users"("discord_id");

-- CreateIndex
CREATE INDEX "users_updated_at_idx" ON "users"("updated_at");

-- CreateIndex
CREATE INDEX "verified_roles_user_id_idx" ON "verified_roles"("user_id");

-- CreateIndex
CREATE INDEX "verified_roles_guild_id_idx" ON "verified_roles"("guild_id");

-- CreateIndex
CREATE INDEX "verified_roles_is_active_idx" ON "verified_roles"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "verified_roles_user_id_guild_id_role_id_key" ON "verified_roles"("user_id", "guild_id", "role_id");

-- CreateIndex
CREATE INDEX "analytics_events_user_id_created_at_idx" ON "analytics_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "analytics_events_created_at_idx" ON "analytics_events"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "themes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verified_roles" ADD CONSTRAINT "verified_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
