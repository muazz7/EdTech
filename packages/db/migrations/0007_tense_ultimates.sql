CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"teacher_id" uuid NOT NULL,
	"course_id" uuid,
	"discount_percent" integer NOT NULL,
	"max_redemptions" integer NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "promo_discount_range" CHECK ("promo_codes"."discount_percent" BETWEEN 1 AND 100),
	CONSTRAINT "promo_quantity_positive" CHECK ("promo_codes"."max_redemptions" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "promo_code_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "discount_poisha" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_teacher_id_profiles_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_codes_teacher_idx" ON "promo_codes" USING btree ("teacher_id") WHERE is_active;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_promo_per_student" ON "payments" USING btree ("promo_code_id","student_id") WHERE promo_code_id IS NOT NULL AND status <> 'rejected';--> statement-breakpoint
CREATE INDEX "payments_promo_idx" ON "payments" USING btree ("promo_code_id") WHERE promo_code_id IS NOT NULL;