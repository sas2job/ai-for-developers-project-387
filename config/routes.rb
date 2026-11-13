Rails.application.routes.draw do
  root "home#index"
  get "book", to: "booking_catalog#index", as: :book
get "admin", to: "admin#index", as: :admin
post "admin/event-types", to: "admin#create_event_type", as: :admin_event_types

namespace :api do
  resources :event_types, path: "event-types", only: %i[index create]
  resources :bookings, only: :create
  get "bookings/upcoming", to: "bookings#upcoming", as: :upcoming_bookings
  get "event-types/:event_type_id/slots", to: "event_type_slots#index", as: :event_type_slots
end

  get "api/health", to: "api/health#show"

  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Render dynamic PWA files from app/views/pwa/* (remember to link manifest in application.html.erb)
  # get "manifest" => "rails/pwa#manifest", as: :pwa_manifest
  # get "service-worker" => "rails/pwa#service_worker", as: :pwa_service_worker

  # Defines the root path route ("/")
  # root "posts#index"
end
