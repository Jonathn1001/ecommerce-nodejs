const AccessControl = require("accesscontrol");

const grandList = [
  { role: "user", resource: "profile", action: "read:own", attributes: ["*"] },
  {
    role: "user",
    resource: "profile",
    action: "update:own",
    attributes: ["*"],
  },
  {
    role: "admin",
    resource: "balance",
    action: "update:any",
    attributes: ["*", "!amount"],
  },
  {
    role: "admin",
    resource: "profiles",
    action: "update:any",
    attributes: ["*"],
  },
  {
    role: "shop",
    resource: "profile",
    action: "read:own",
    attributes: ["*"],
  },
  {
    role: "shop",
    resource: "balance",
    action: "update:own",
    attributes: ["*", "!amount"],
  },
];

const ac = new AccessControl(grandList);
module.exports = ac;
