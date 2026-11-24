-- AS delivery plans are separate from material inventory and production counts.
-- Existing inventory, inspection records, accounts and passkeys are unchanged.
CREATE TABLE ops_deliveries(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES ops_items(id),code TEXT NOT NULL,customer TEXT NOT NULL,due_date TEXT NOT NULL DEFAULT '',quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999999),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','released','held','delivered','cancelled')),created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,delivered_by TEXT REFERENCES users(id),delivered_at TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(item_id,code));
CREATE TABLE ops_delivery_inspections(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES ops_deliveries(id),sample INTEGER NOT NULL CHECK(sample>0),failed INTEGER NOT NULL CHECK(failed>=0 AND failed<=sample),decision TEXT NOT NULL CHECK(decision IN('pass','fail')),criteria TEXT NOT NULL,measurements TEXT NOT NULL,reason TEXT NOT NULL,item_snapshot TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,CHECK(decision!='pass' OR failed=0));
CREATE INDEX ops_deliveries_status ON ops_deliveries(status,created_at,id);
CREATE INDEX ops_delivery_inspections_lot ON ops_delivery_inspections(delivery_id,created_at,id);
CREATE TRIGGER ops_deliveries_no_delete BEFORE DELETE ON ops_deliveries BEGIN SELECT RAISE(ABORT,'delivery history must be retained'); END;
CREATE TRIGGER ops_deliveries_closed BEFORE UPDATE ON ops_deliveries WHEN OLD.status IN('delivered','cancelled') BEGIN SELECT RAISE(ABORT,'closed delivery is immutable'); END;
CREATE TRIGGER ops_delivery_inspections_no_update BEFORE UPDATE ON ops_delivery_inspections BEGIN SELECT RAISE(ABORT,'inspection history is immutable'); END;
CREATE TRIGGER ops_delivery_inspections_no_delete BEFORE DELETE ON ops_delivery_inspections BEGIN SELECT RAISE(ABORT,'inspection history is immutable'); END;
-- worker_revision exists only on D1.
CREATE TRIGGER revision_ops_deliveries_insert AFTER INSERT ON ops_deliveries BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_ops_deliveries_update AFTER UPDATE ON ops_deliveries BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_ops_deliveries_delete AFTER DELETE ON ops_deliveries BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_ops_delivery_inspections_insert AFTER INSERT ON ops_delivery_inspections BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_ops_delivery_inspections_update AFTER UPDATE ON ops_delivery_inspections BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER revision_ops_delivery_inspections_delete AFTER DELETE ON ops_delivery_inspections BEGIN UPDATE worker_revision SET revision=revision+1 WHERE id=1; END;
