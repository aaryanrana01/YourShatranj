CREATE TYPE "public"."game_status" AS ENUM('active', 'ended', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."time_class" AS ENUM('bullet', 'blitz', 'rapid');--> statement-breakpoint
CREATE TABLE "games" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"white_id" uuid NOT NULL,
	"black_id" uuid NOT NULL,
	"time_control" varchar(10) NOT NULL,
	"time_class" time_class NOT NULL,
	"rated" boolean DEFAULT true NOT NULL,
	"status" "game_status" DEFAULT 'active' NOT NULL,
	"result" varchar(7) DEFAULT '*' NOT NULL,
	"end_reason" varchar(32),
	"pgn" text,
	"final_fen" text,
	"white_rating_before" integer,
	"white_rating_after" integer,
	"black_rating_before" integer,
	"black_rating_after" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"game_id" varchar(12) NOT NULL,
	"ply" integer NOT NULL,
	"uci" varchar(5) NOT NULL,
	"san" varchar(10) NOT NULL,
	"clock_ms" integer NOT NULL,
	CONSTRAINT "moves_game_id_ply_pk" PRIMARY KEY("game_id","ply")
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"user_id" uuid NOT NULL,
	"time_class" time_class NOT NULL,
	"rating" real DEFAULT 1500 NOT NULL,
	"deviation" real DEFAULT 350 NOT NULL,
	"volatility" real DEFAULT 0.06 NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_user_id_time_class_pk" PRIMARY KEY("user_id","time_class")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(20) NOT NULL,
	"username_key" varchar(20) NOT NULL,
	"password_hash" text NOT NULL,
	"is_banned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_username_key_unique" UNIQUE("username_key")
);
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_white_id_users_id_fk" FOREIGN KEY ("white_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_black_id_users_id_fk" FOREIGN KEY ("black_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "games_white_idx" ON "games" USING btree ("white_id","ended_at");--> statement-breakpoint
CREATE INDEX "games_black_idx" ON "games" USING btree ("black_id","ended_at");--> statement-breakpoint
CREATE INDEX "refresh_family_idx" ON "refresh_tokens" USING btree ("family_id");