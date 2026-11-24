import { practice } from './practice';

export const { waitlist } = practice;
export const availabilityNotice = waitlist.acceptingNewClients
  ? 'The sandbox practice is accepting new clients.'
  : 'The sandbox practice is waitlisting new clients. Intake appointments are currently closed.';
