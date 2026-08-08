CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"channel" "payment_channel" NOT NULL,
	"account_number" text NOT NULL,
	"account_type" text,
	"account_label" text,
	"instructions" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_owner_channel_number_key" ON "payment_methods" USING btree ("owner_id","channel","account_number") WHERE is_active;--> statement-breakpoint
CREATE INDEX "payment_methods_owner_idx" ON "payment_methods" USING btree ("owner_id") WHERE is_active;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reviewer_id_profiles_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_reviewer_pending_idx" ON "payments" USING btree ("reviewer_id","submitted_at") WHERE status = 'pending';